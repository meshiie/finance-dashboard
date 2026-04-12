import { google } from "googleapis";
import { writeFileSync } from "fs";

const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});
const sheets = google.sheets({ version: "v4", auth });

async function readSheet(range) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range });
  return res.data.values || [];
}

// ── Freshness check ───────────────────────────────────────────────────────────
async function checkDataFreshness() {
  const balancesRaw = await readSheet("Balances!A:E");
  const timestamps = balancesRaw.slice(1)
    .map(r => r[4])
    .filter(v => v && String(v).trim() !== "")
    .map(v => new Date(String(v).trim()))
    .filter(d => !isNaN(d.getTime()));

  if (timestamps.length === 0) {
    console.warn("⚠️  No Last Updated timestamps found — proceeding anyway");
    return { fresh: true };
  }

  const mostRecent = new Date(Math.max(...timestamps.map(d => d.getTime())));
  const now = new Date();
  const ageHours = (now.getTime() - mostRecent.getTime()) / (1000 * 60 * 60);
  const lastSyncedStr = mostRecent.toLocaleString("en-AU", {
    timeZone: "Australia/Sydney",
    weekday: "short", day: "numeric", month: "short",
    hour: "2-digit", minute: "2-digit",
  });

  console.log(`🕐 Redbark last synced: ${lastSyncedStr} (${ageHours.toFixed(1)}h ago)`);
  return { fresh: ageHours <= 24, ageHours: ageHours.toFixed(1), lastSyncedStr };
}

async function sendFreshnessTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: "HTML" }),
  });
  if (!res.ok) console.error("Telegram freshness alert failed:", res.status);
  else console.log("✅ Freshness alert sent");
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function parseAmount(val) {
  if (!val && val !== 0) return 0;
  return Math.abs(parseFloat(String(val).replace(/[$,\s()]/g, "")) || 0);
}

const GROCERY_MERCHANTS = [
  "woolworths","coles","aldi","iga","harris farm","costco",
  "foodworks","spar","drakes","supabarn","ritchies",
  "bulk nutrients","chemist warehouse","priceline",
];
function isGrocery(desc) { return GROCERY_MERCHANTS.some(m => (desc||"").toLowerCase().includes(m)); }
function isMortgage(desc) { return (desc||"").toLowerCase().includes("withdrawal direct debit"); }

const CAT_MAP = {
  TRANSPORTATION:"Transport", MEDICAL:"Health & medical",
  PERSONAL_CARE:"Personal care & beauty", ENTERTAINMENT:"Entertainment",
  MERCHANDISE:"Shopping & clothing", RENT_AND_UTILITIES:"Utilities & bills",
  LOAN_PAYMENTS:"Insurance", HOME_IMPROVEMENT:"Home & garden",
  GOVERNMENT_AND_NON_PROFIT:"Govt & non-profit", SERVICES:"Services",
};

// ── Category resolution — Overrides take priority over Redbark ────────────────
function resolveCategory(cat, desc, overrides) {
  if (isMortgage(desc)) return "Mortgage";

  // Check overrides first (keyword match on description)
  const d = (desc || "").toLowerCase();
  for (const ov of overrides) {
    if (!ov.keyword) continue;
    if (d.includes(ov.keyword.toLowerCase())) {
      return ov.category; // "skip" is a valid return here
    }
  }

  // Fall back to Redbark category
  if (cat === "FOOD_AND_DRINK") return isGrocery(desc) ? "Groceries" : "Eating out & cafes";
  return CAT_MAP[cat] || null;
}

const SKIP_CATS = new Set(["TRANSFER_OUT","TRANSFER_IN","INCOME","nan",""]);
function isRealSpend(cat, desc, overrides) {
  if (isMortgage(desc)) return true;
  const resolved = resolveCategory(cat, desc, overrides);
  if (resolved === "skip") return false;
  if (resolved && resolved !== "skip") return true; // override says it's real spend
  return !SKIP_CATS.has(cat);
}

function getCycleBounds(nextPaydayStr, cycleDays) {
  const now = new Date();
  const nextPayday = new Date(nextPaydayStr + "T00:00:00Z");
  const msDay = 86400000;
  const daysSince = Math.floor((now - nextPayday) / msDay);
  const offset = daysSince < 0 ? Math.ceil(daysSince/cycleDays)-1 : Math.floor(daysSince/cycleDays);
  const thisCycleStart = new Date(nextPayday.getTime() + offset * cycleDays * msDay);
  const prevCycleStart = new Date(thisCycleStart.getTime() - cycleDays * msDay);
  const daysElapsed = Math.max(0, Math.floor((now - thisCycleStart) / msDay));
  const daysRemaining = cycleDays - daysElapsed;
  return { thisCycleStart, prevCycleStart, daysElapsed, daysRemaining, cycleDays };
}

function parseTxns(rows) {
  return rows.slice(1).map(row => ({
    date: new Date(row[1]),
    desc: String(row[2]||""),
    amount: parseAmount(row[3]),
    direction: String(row[5]||"").toLowerCase(),
    cat: String(row[6]||"").trim(),
  })).filter(t =>
    !isNaN(t.date.getTime()) &&
    !t.desc.toUpperCase().includes("AUTHORISATION") &&
    !t.desc.toUpperCase().includes("AUTHORIZATION")
  );
}

function buildCatTotals(txns, from, to, overrides) {
  const out = {};
  for (const t of txns) {
    if (t.date < from) continue;
    if (to && t.date >= to) continue;

    // Credits — handle reimbursements
    if (t.direction === "credit") {
      const d = (t.desc||"").toLowerCase();
      const isReimbursement = overrides.some(ov =>
        ov.category === "reimbursement" && ov.keyword && d.includes(ov.keyword.toLowerCase())
      );
      if (isReimbursement) {
        out["__reimbursements__"] = (out["__reimbursements__"]||0) + t.amount;
      }
      continue;
    }

    // Debits — normal spend logic
    if (t.direction !== "debit") continue;
    if (!isRealSpend(t.cat, t.desc, overrides)) continue;
    const tag = resolveCategory(t.cat, t.desc, overrides);
    if (!tag || tag === "skip") continue;
    out[tag] = (out[tag]||0) + t.amount;
  }
  return out;
}

function sanitiseAccountLabel(rawLabel) {
  const label = String(rawLabel||"");
  if (label.toLowerCase().includes("bill")) return "Bills account";
  if (label.toLowerCase().includes("spend")) return "Spend account";
  const match = label.match(/\((\d+)\)/);
  if (match) {
    const last4 = match[1].slice(-4);
    if (last4 === "4252") return "Offset savings";
    if (last4 === "1524") return "Main offset";
    return `Account (${last4})`;
  }
  return "Account";
}

const DAY_NAMES = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];

function getFixedBillsDue(bills, windowStart, windowDays) {
  const windowEnd = new Date(windowStart.getTime() + windowDays * 86400000);
  const due = [];
  for (const bill of bills) {
    if (String(bill.active||"").toUpperCase() !== "YES") continue;
    const freq = String(bill.frequency||"").toLowerCase();
    if (freq === "adhoc") continue;
    const dueDay = String(bill.due_day||"").trim();
    if (freq === "weekly") {
      const targetDayIdx = DAY_NAMES.indexOf(dueDay.toLowerCase());
      if (targetDayIdx === -1) continue;
      let cursor = new Date(windowStart);
      while (cursor < windowEnd) {
        if (cursor.getUTCDay() === targetDayIdx) due.push({ ...bill, due_date: new Date(cursor) });
        cursor = new Date(cursor.getTime() + 86400000);
      }
    } else if (freq === "monthly") {
      const dayNum = parseInt(dueDay);
      if (isNaN(dayNum)) continue;
      const monthsToCheck = new Set([
        `${windowStart.getUTCFullYear()}-${windowStart.getUTCMonth()}`,
        `${windowEnd.getUTCFullYear()}-${windowEnd.getUTCMonth()}`,
      ]);
      for (const key of monthsToCheck) {
        const [yr, mo] = key.split("-").map(Number);
        const dueDate = new Date(Date.UTC(yr, mo, dayNum));
        if (dueDate >= windowStart && dueDate < windowEnd) due.push({ ...bill, due_date: dueDate });
      }
    }
  }
  return due.sort((a,b) => a.due_date - b.due_date);
}

function checkBillPaid(bill, dueDate, transactions) {
  const windowMs = 4 * 86400000;
  const keyword = String(bill.match_keyword||"").toLowerCase();
  const billAmount = parseFloat(bill.amount)||0;
  const matches = transactions.filter(t => {
    if (t.direction !== "debit") return false;
    if (!t.desc.toLowerCase().includes(keyword)) return false;
    return Math.abs(t.date.getTime() - dueDate.getTime()) <= windowMs;
  });
  if (matches.length === 0) return false;
  if (billAmount > 0) return matches.some(t => Math.abs(t.amount - billAmount) < 2);
  return true;
}

function getAdhocBillOccurrences(bill, transactions, cycleStart) {
  const keyword = String(bill.match_keyword||"").toLowerCase();
  return transactions
    .filter(t => t.direction==="debit" && t.date>=cycleStart && t.desc.toLowerCase().includes(keyword))
    .sort((a,b) => a.date-b.date)
    .map(t => ({
      date: t.date.toISOString().slice(0,10),
      date_label: t.date.toLocaleDateString("en-AU",{timeZone:"Australia/Sydney",weekday:"short",day:"numeric",month:"short"}),
      amount: parseFloat(t.amount.toFixed(2)),
      desc: t.desc.slice(0,60),
    }));
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("📊 Generating dashboard data:", new Date().toISOString());

  // Freshness check
  const freshness = await checkDataFreshness();
  if (!freshness.fresh) {
    console.error(`❌ Stale data — last synced ${freshness.ageHours}h ago. Aborting.`);
    const msg = `⚠️ <b>Redbark sync alert</b>\n\nYour bank data hasn't updated in <b>${freshness.ageHours} hours</b>.\nLast synced: ${freshness.lastSyncedStr}\n\nDashboard and briefings are running on stale data.\n\n👉 Check your <a href="https://app.redbark.co">Redbark dashboard</a> and reconnect if needed.`;
    await sendFreshnessTelegram(msg);
    process.exit(0);
  }

  const configRaw = await readSheet("Config!A:B");
  const cfg = Object.fromEntries((configRaw.slice(1)||[]).filter(r=>r[0]).map(r=>[r[0],r[1]]));

  const spendSheet = cfg.spend_sheet || "Spend account (0524)";
  const billsSheet = cfg.bills_sheet || "Bills account (6660)";
  const offsetSheet = cfg.offset_sheet || "Pramesh Singh (1524)";

  const fnIncome = parseFloat(cfg.fortnightly_income||4215);
  const fnSpendBudget = parseFloat(cfg.fortnightly_spend_budget||1000);
  const fnSavingsTarget = parseFloat(cfg.fortnightly_savings_target||600);
  const savingsTargetPct = parseFloat(cfg.savings_target_pct||14.2);
  const nextPayday = cfg.next_payday || "2026-04-08";
  const cycleDays = parseInt(cfg.pay_cycle_days||14);

  const cycle = getCycleBounds(nextPayday, cycleDays);
  const now = new Date();

  const [balancesRaw, pricesRaw, budgetRaw, billsScheduleRaw, overridesRaw,
    spend0524Raw, bills6660Raw, main1524Raw] = await Promise.all([
    readSheet("Balances!A:E"),
    readSheet("Prices!A:M"),
    readSheet("Budget!A:C"),
    readSheet("Bills Schedule!A:G"),
    readSheet("Overrides!A:E"),
    readSheet(`${spendSheet}!A:L`),
    readSheet(`${billsSheet}!A:L`),
    readSheet(`${offsetSheet}!A:L`),
  ]);

  // Parse overrides — keyword → category mapping
  const overrides = overridesRaw.slice(1)
    .filter(r => r[0] && r[1])
    .map(r => ({
      keyword: String(r[0]).trim(),
      category: String(r[1]).trim(),
      notes: String(r[2]||"").trim(),
    }));
  console.log(`📋 Loaded ${overrides.length} overrides`);

  // Balances
  const balances = balancesRaw.slice(1)
    .filter(r=>r[0]&&r[1])
    .map(r=>({ label:sanitiseAccountLabel(r[0]), amount:parseAmount(r[1]) }))
    .filter(b=>b.amount>0);
  const totalBalance = balances.reduce((s,b)=>s+b.amount,0);

  // Transactions
  const spend0524 = parseTxns(spend0524Raw);
  const bills6660 = parseTxns(bills6660Raw);
  const main1524 = parseTxns(main1524Raw);
  const allTxns = [...spend0524,...bills6660,...main1524];

  // Discretionary (Spend 0524 only) — with overrides + reimbursements applied
  const discretionaryCatsRaw = buildCatTotals(spend0524, cycle.thisCycleStart, null, overrides);
  const totalReimbursed = parseFloat((discretionaryCatsRaw["__reimbursements__"] || 0).toFixed(2));
  delete discretionaryCatsRaw["__reimbursements__"];
  const discretionaryCats = discretionaryCatsRaw;
  const discretionaryGross = Object.values(discretionaryCats).reduce((a,b)=>a+b,0);
  const discretionaryTotal = Math.max(0, discretionaryGross - totalReimbursed);
  const discretionaryRemaining = Math.max(0, fnSpendBudget-discretionaryTotal);
  const projectedDiscretionary = cycle.daysElapsed>0
    ? Math.round((discretionaryTotal/cycle.daysElapsed)*cycle.cycleDays) : 0;
  const pctUsed = Math.round((discretionaryTotal/fnSpendBudget)*100);

  // All-account spend
  const allCatsThisCycle = buildCatTotals(allTxns, cycle.thisCycleStart, null, overrides);
  const mortgageThisCycle = allCatsThisCycle["Mortgage"]||0;
  const totalSpendThisCycle = Object.values(allCatsThisCycle).reduce((a,b)=>a+b,0);

  const actualSavings = fnIncome-totalSpendThisCycle;
  const savingsRate = fnIncome>0?parseFloat(((actualSavings/fnIncome)*100).toFixed(1)):0;
  const onTrackSavings = actualSavings>=fnSavingsTarget;

  // Budget comparison
  const budgetObjs = budgetRaw.slice(1).filter(r=>r[0]&&r[2]).map(r=>({
    category:String(r[0]).trim(), fnBudget:parseFloat(r[2])/2,
  }));
  const categoryData = budgetObjs
    .filter(b=>b.category!=="Mortgage"&&b.fnBudget>0)
    .map(b=>({
      name:b.category,
      spent:parseFloat((discretionaryCats[b.category]||0).toFixed(2)),
      budget:parseFloat(b.fnBudget.toFixed(2)),
      over:(discretionaryCats[b.category]||0)>b.fnBudget,
    }))
    .sort((a,b)=>b.spent-a.spent);

  // Bills
  const billsSchedule = billsScheduleRaw.slice(1).filter(r=>r[0]).map(r=>({
    name:String(r[0]||"").trim(), amount:parseFloat(r[1])||0,
    frequency:String(r[2]||"").trim().toLowerCase(),
    due_day:String(r[3]||"").trim(), account:String(r[4]||"").trim().toLowerCase(),
    match_keyword:String(r[5]||"").trim(), active:String(r[6]||"").trim().toUpperCase(),
  }));

  const fixedBillsDue = getFixedBillsDue(billsSchedule, cycle.thisCycleStart, cycle.cycleDays);
  const fixedBillsWithStatus = fixedBillsDue.map(bill => {
    const isPaid = checkBillPaid(bill, bill.due_date, allTxns);
    const isOverdue = !isPaid && bill.due_date < now;
    const daysUntilDue = Math.ceil((bill.due_date.getTime()-now.getTime())/86400000);
    return {
      name:bill.name, amount:parseFloat(bill.amount.toFixed(2)), frequency:bill.frequency,
      due_date:bill.due_date.toISOString().slice(0,10),
      due_label:bill.due_date.toLocaleDateString("en-AU",{timeZone:"Australia/Sydney",weekday:"short",day:"numeric",month:"short"}),
      account:bill.account,
      status:isPaid?"paid":isOverdue?"overdue":"upcoming",
      days_until:daysUntilDue, type:"fixed",
    };
  });

  const adhocBills = billsSchedule.filter(b=>b.frequency==="adhoc"&&String(b.active).toUpperCase()==="YES");
  const adhocBillsData = adhocBills.map(bill => {
    const occurrences = getAdhocBillOccurrences(bill, allTxns, cycle.thisCycleStart);
    const totalSpent = occurrences.reduce((s,o)=>s+o.amount,0);
    return {
      name:bill.name, budget:parseFloat(bill.amount.toFixed(2)),
      total_spent:parseFloat(totalSpent.toFixed(2)), count:occurrences.length,
      pct_of_budget:bill.amount>0?Math.round((totalSpent/bill.amount)*100):0,
      over:totalSpent>bill.amount, account:bill.account, occurrences, type:"adhoc",
    };
  });

  const totalBillsDue = fixedBillsWithStatus.reduce((s,b)=>s+b.amount,0);
  const totalBillsPaid = fixedBillsWithStatus.filter(b=>b.status==="paid").reduce((s,b)=>s+b.amount,0);
  const totalBillsUpcoming = fixedBillsWithStatus.filter(b=>b.status==="upcoming").reduce((s,b)=>s+b.amount,0);
  const totalBillsOverdue = fixedBillsWithStatus.filter(b=>b.status==="overdue").reduce((s,b)=>s+b.amount,0);
  const billsPaidPct = totalBillsDue>0?Math.round((totalBillsPaid/totalBillsDue)*100):0;

  const calendarDays = Array.from({length:cycle.cycleDays},(_,i)=>{
    const dayDate = new Date(cycle.thisCycleStart.getTime()+i*86400000);
    const dateStr = dayDate.toISOString().slice(0,10);
    const isToday = dateStr===now.toISOString().slice(0,10);
    const fixedOnDay = fixedBillsWithStatus.filter(b=>b.due_date===dateStr);
    const adhocOnDay = adhocBillsData.flatMap(bill=>
      bill.occurrences.filter(o=>o.date===dateStr).map(o=>({name:bill.name,amount:o.amount,status:"adhoc",type:"adhoc"}))
    );
    return {
      date:dateStr,
      day_label:dayDate.toLocaleDateString("en-AU",{timeZone:"Australia/Sydney",weekday:"short"}),
      day_num:dayDate.getUTCDate(), is_today:isToday,
      is_past:dayDate<now&&!isToday, bills:[...fixedOnDay,...adhocOnDay],
    };
  });

  // Portfolio
  const priceRows = pricesRaw.slice(1).filter(r=>r[0]);
  const holdings = priceRows
    .filter(r=>parseAmount(r[8])>0&&!String(r[6]||"").includes("ERROR"))
    .map(r=>({
      ticker:String(r[0]), name:String(r[1]||""),
      units:parseFloat(r[2])||0, price:parseFloat(r[6])||0,
      value:parseFloat(parseAmount(r[8]).toFixed(2)),
      cost:parseFloat(parseAmount(r[9]).toFixed(2)),
      pl:(()=>{const raw=String(r[10]||"0");const abs=parseAmount(raw);return raw.includes("-")?-abs:abs;})(),
      pl_pct:parseFloat(r[11])||0, change_24h:parseFloat(r[7])||0,
      platform:String(r[4]||""), asset_type:String(r[5]||""),
    }))
    .sort((a,b)=>b.value-a.value);

  const portfolioTotal = holdings.reduce((s,h)=>s+h.value,0);
  const portfolioCost = holdings.reduce((s,h)=>s+h.cost,0);
  const portfolioPL = portfolioTotal-portfolioCost;
  const portfolioPLPct = portfolioCost>0?parseFloat(((portfolioPL/portfolioCost)*100).toFixed(1)):0;
  const topMovers = [...holdings]
    .filter(h=>h.change_24h!==0)
    .sort((a,b)=>Math.abs(b.change_24h)-Math.abs(a.change_24h))
    .slice(0,3).map(h=>({ticker:h.ticker,change:h.change_24h}));

  const updatedStr = now.toLocaleString("en-AU",{timeZone:"Australia/Sydney",weekday:"short",day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"});

  const data = {
    meta:{ updated:updatedStr, updated_iso:now.toISOString() },
    cycle:{ day:cycle.daysElapsed+1, total_days:cycle.cycleDays, days_remaining:cycle.daysRemaining, cycle_start:cycle.thisCycleStart.toISOString().slice(0,10) },
    discretionary:{ spent:parseFloat(discretionaryTotal.toFixed(2)), budget:fnSpendBudget, remaining:parseFloat(discretionaryRemaining.toFixed(2)), projected:projectedDiscretionary, pct_used:pctUsed, reimbursed:totalReimbursed },
    savings:{ amount:parseFloat(actualSavings.toFixed(2)), target:fnSavingsTarget, rate_pct:savingsRate, target_rate_pct:savingsTargetPct, on_track:onTrackSavings },
    spending:{ categories:categoryData, mortgage:parseFloat(mortgageThisCycle.toFixed(2)), total_all_accounts:parseFloat(totalSpendThisCycle.toFixed(2)) },
    bills:{ summary:{ total_due:parseFloat(totalBillsDue.toFixed(2)), total_paid:parseFloat(totalBillsPaid.toFixed(2)), total_upcoming:parseFloat(totalBillsUpcoming.toFixed(2)), total_overdue:parseFloat(totalBillsOverdue.toFixed(2)), paid_pct:billsPaidPct }, fixed:fixedBillsWithStatus, adhoc:adhocBillsData, calendar:calendarDays },
    balances:{ accounts:balances, total:parseFloat(totalBalance.toFixed(2)) },
    portfolio:{ total:parseFloat(portfolioTotal.toFixed(2)), cost:parseFloat(portfolioCost.toFixed(2)), pl:parseFloat(portfolioPL.toFixed(2)), pl_pct:portfolioPLPct, holdings, top_movers:topMovers },
  };

  writeFileSync("data.json", JSON.stringify(data, null, 2));
  console.log(`✅ data.json written — ${overrides.length} overrides applied`);
  console.log(`   Bills: ${fixedBillsWithStatus.length} due | ${fixedBillsWithStatus.filter(b=>b.status==="paid").length} paid`);
  console.log(`   Portfolio: $${portfolioTotal.toFixed(2)} | Discretionary: $${discretionaryTotal.toFixed(2)}/$${fnSpendBudget} | Reimbursed: $${totalReimbursed}`);
}

main().catch(err => { console.error("💥", err); process.exit(1); });
