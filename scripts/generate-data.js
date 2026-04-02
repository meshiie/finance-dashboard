import { google } from "googleapis";
import { writeFileSync } from "fs";

const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});
const sheets = google.sheets({ version: "v4", auth });

async function readSheet(range) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range });
  return res.data.values || [];
}

function parseAmount(val) {
  if (!val && val !== 0) return 0;
  const s = String(val).replace(/[$,\s()]/g, "");
  return Math.abs(parseFloat(s) || 0);
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

function tagTxn(cat, desc) {
  if (isMortgage(desc)) return "Mortgage";
  if (cat === "FOOD_AND_DRINK") return isGrocery(desc) ? "Groceries" : "Eating out & cafes";
  return CAT_MAP[cat] || null;
}

const SKIP_CATS = new Set(["TRANSFER_OUT","TRANSFER_IN","INCOME","nan",""]);
function isRealSpend(cat, desc) {
  if (isMortgage(desc)) return true;
  return !SKIP_CATS.has(cat);
}

function getCycleBounds(nextPaydayStr, cycleDays) {
  const now = new Date();
  const nextPayday = new Date(nextPaydayStr + "T00:00:00Z");
  const msDay = 86400000;
  const daysSince = Math.floor((now - nextPayday) / msDay);
  const offset = daysSince < 0 ? Math.ceil(daysSince / cycleDays) - 1 : Math.floor(daysSince / cycleDays);
  const thisCycleStart = new Date(nextPayday.getTime() + offset * cycleDays * msDay);
  const prevCycleStart = new Date(thisCycleStart.getTime() - cycleDays * msDay);
  const daysElapsed = Math.max(0, Math.floor((now - thisCycleStart) / msDay));
  const daysRemaining = cycleDays - daysElapsed;
  return { thisCycleStart, prevCycleStart, daysElapsed, daysRemaining, cycleDays };
}

function parseTxns(rows) {
  return rows.slice(1).map(row => ({
    date: new Date(row[1]),
    desc: String(row[2] || ""),
    amount: parseAmount(row[3]),
    direction: String(row[5] || "").toLowerCase(),
    cat: String(row[6] || "").trim(),
  })).filter(t => !isNaN(t.date.getTime()));
}

function buildCatTotals(txns, from, to) {
  const out = {};
  for (const t of txns) {
    if (t.direction !== "debit") continue;
    if (t.date < from) continue;
    if (to && t.date >= to) continue;
    if (!isRealSpend(t.cat, t.desc)) continue;
    const tag = tagTxn(t.cat, t.desc);
    if (!tag) continue;
    out[tag] = (out[tag] || 0) + t.amount;
  }
  return out;
}

function sanitiseAccountLabel(rawLabel) {
  const label = String(rawLabel || "");
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

// ── Bill due-date calculation (fixed/weekly/monthly) ─────────────────────────
function getFixedBillsDue(bills, windowStart, windowDays) {
  const windowEnd = new Date(windowStart.getTime() + windowDays * 86400000);
  const due = [];

  for (const bill of bills) {
    if (String(bill.active||"").toUpperCase() !== "YES") continue;
    const freq = String(bill.frequency||"").toLowerCase();
    if (freq === "adhoc") continue; // handled separately

    const dueDay = String(bill.due_day||"").trim();

    if (freq === "weekly") {
      const targetDayIdx = DAY_NAMES.indexOf(dueDay.toLowerCase());
      if (targetDayIdx === -1) continue;
      let cursor = new Date(windowStart);
      while (cursor < windowEnd) {
        if (cursor.getUTCDay() === targetDayIdx) {
          due.push({ ...bill, due_date: new Date(cursor) });
        }
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
        if (dueDate >= windowStart && dueDate < windowEnd) {
          due.push({ ...bill, due_date: dueDate });
        }
      }
    }
  }
  return due.sort((a, b) => a.due_date - b.due_date);
}

function checkBillPaid(bill, dueDate, transactions) {
  const windowMs = 4 * 86400000;
  const keyword = String(bill.match_keyword||"").toLowerCase();
  const billAmount = parseFloat(bill.amount) || 0;
  const matches = transactions.filter(t => {
    if (t.direction !== "debit") return false;
    if (!t.desc.toLowerCase().includes(keyword)) return false;
    return Math.abs(t.date.getTime() - dueDate.getTime()) <= windowMs;
  });
  if (matches.length === 0) return false;
  if (billAmount > 0) return matches.some(t => Math.abs(t.amount - billAmount) < 2);
  return true;
}

// ── Adhoc bill detection ──────────────────────────────────────────────────────
function getAdhocBillOccurrences(bill, transactions, cycleStart) {
  const keyword = String(bill.match_keyword||"").toLowerCase();
  return transactions
    .filter(t =>
      t.direction === "debit" &&
      t.date >= cycleStart &&
      t.desc.toLowerCase().includes(keyword)
    )
    .sort((a, b) => a.date - b.date)
    .map(t => ({
      date: t.date.toISOString().slice(0, 10),
      date_label: t.date.toLocaleDateString("en-AU", {
        timeZone: "Australia/Sydney",
        weekday: "short", day: "numeric", month: "short",
      }),
      amount: parseFloat(t.amount.toFixed(2)),
      desc: t.desc.slice(0, 60),
    }));
}

async function main() {
  console.log("📊 Generating dashboard data:", new Date().toISOString());

  const configRaw = await readSheet("Config!A:B");
  const cfg = Object.fromEntries(
    (configRaw.slice(1)||[]).filter(r => r[0]).map(r => [r[0], r[1]])
  );

  const spendSheet = cfg.spend_sheet || "Spend account (0524)";
  const billsSheet = cfg.bills_sheet || "Bills account (6660)";
  const offsetSheet = cfg.offset_sheet || "Pramesh Singh (1524)";

  const fnIncome = parseFloat(cfg.fortnightly_income || 4215);
  const fnSpendBudget = parseFloat(cfg.fortnightly_spend_budget || 1000);
  const fnSavingsTarget = parseFloat(cfg.fortnightly_savings_target || 600);
  const savingsTargetPct = parseFloat(cfg.savings_target_pct || 14.2);
  const nextPayday = cfg.next_payday || "2026-04-08";
  const cycleDays = parseInt(cfg.pay_cycle_days || 14);

  const cycle = getCycleBounds(nextPayday, cycleDays);
  const now = new Date();

  const [balancesRaw, pricesRaw, budgetRaw, billsScheduleRaw,
    spend0524Raw, bills6660Raw, main1524Raw] = await Promise.all([
    readSheet("Balances!A:E"),
    readSheet("Prices!A:M"),
    readSheet("Budget!A:C"),
    readSheet("Bills Schedule!A:G"),
    readSheet(`${spendSheet}!A:L`),
    readSheet(`${billsSheet}!A:L`),
    readSheet(`${offsetSheet}!A:L`),
  ]);

  const balances = balancesRaw.slice(1)
    .filter(r => r[0] && r[1])
    .map(r => ({ label: sanitiseAccountLabel(r[0]), amount: parseAmount(r[1]) }))
    .filter(b => b.amount > 0);
  const totalBalance = balances.reduce((s, b) => s + b.amount, 0);

  const spend0524 = parseTxns(spend0524Raw);
  const bills6660 = parseTxns(bills6660Raw);
  const main1524 = parseTxns(main1524Raw);
  const allTxns = [...spend0524, ...bills6660, ...main1524];

  const discretionaryCats = buildCatTotals(spend0524, cycle.thisCycleStart);
  const discretionaryTotal = Object.values(discretionaryCats).reduce((a,b)=>a+b,0);
  const discretionaryRemaining = Math.max(0, fnSpendBudget - discretionaryTotal);
  const projectedDiscretionary = cycle.daysElapsed > 0
    ? Math.round((discretionaryTotal / cycle.daysElapsed) * cycle.cycleDays) : 0;
  const pctUsed = Math.round((discretionaryTotal / fnSpendBudget) * 100);

  const allCatsThisCycle = buildCatTotals(allTxns, cycle.thisCycleStart);
  const mortgageThisCycle = allCatsThisCycle["Mortgage"] || 0;
  const totalSpendThisCycle = Object.values(allCatsThisCycle).reduce((a,b)=>a+b,0);

  const actualSavings = fnIncome - totalSpendThisCycle;
  const savingsRate = fnIncome > 0 ? parseFloat(((actualSavings/fnIncome)*100).toFixed(1)) : 0;
  const onTrackSavings = actualSavings >= fnSavingsTarget;

  const budgetObjs = budgetRaw.slice(1).filter(r=>r[0]&&r[2]).map(r=>({
    category: String(r[0]).trim(),
    fnBudget: parseFloat(r[2]) / 2,
  }));
  const categoryData = budgetObjs
    .filter(b => b.category !== "Mortgage" && b.fnBudget > 0)
    .map(b => ({
      name: b.category,
      spent: parseFloat((discretionaryCats[b.category]||0).toFixed(2)),
      budget: parseFloat(b.fnBudget.toFixed(2)),
      over: (discretionaryCats[b.category]||0) > b.fnBudget,
    }))
    .sort((a,b) => b.spent - a.spent);

  // ── Bills schedule ────────────────────────────────────────────────────────
  const billsSchedule = billsScheduleRaw.slice(1).filter(r=>r[0]).map(r=>({
    name: String(r[0]||"").trim(),
    amount: parseFloat(r[1]) || 0,
    frequency: String(r[2]||"").trim().toLowerCase(),
    due_day: String(r[3]||"").trim(),
    account: String(r[4]||"").trim().toLowerCase(),
    match_keyword: String(r[5]||"").trim(),
    active: String(r[6]||"").trim().toUpperCase(),
  }));

  // Fixed/weekly/monthly bills due this cycle
  const fixedBillsDue = getFixedBillsDue(billsSchedule, cycle.thisCycleStart, cycle.cycleDays);
  const fixedBillsWithStatus = fixedBillsDue.map(bill => {
    const isPaid = checkBillPaid(bill, bill.due_date, allTxns);
    const isOverdue = !isPaid && bill.due_date < now;
    const daysUntilDue = Math.ceil((bill.due_date.getTime() - now.getTime()) / 86400000);
    return {
      name: bill.name,
      amount: parseFloat(bill.amount.toFixed(2)),
      frequency: bill.frequency,
      due_date: bill.due_date.toISOString().slice(0, 10),
      due_label: bill.due_date.toLocaleDateString("en-AU", {
        timeZone: "Australia/Sydney",
        weekday: "short", day: "numeric", month: "short",
      }),
      account: bill.account,
      status: isPaid ? "paid" : isOverdue ? "overdue" : "upcoming",
      days_until: daysUntilDue,
      type: "fixed",
    };
  });

  // Adhoc bills — scan transactions this cycle for keyword matches
  const adhocBills = billsSchedule.filter(b =>
    b.frequency === "adhoc" &&
    String(b.active).toUpperCase() === "YES"
  );

  const adhocBillsData = adhocBills.map(bill => {
    const occurrences = getAdhocBillOccurrences(bill, allTxns, cycle.thisCycleStart);
    const totalSpent = occurrences.reduce((s, o) => s + o.amount, 0);
    const budget = bill.amount; // amount = fortnightly budget cap for adhoc
    const pct = budget > 0 ? Math.round((totalSpent / budget) * 100) : 0;
    return {
      name: bill.name,
      budget: parseFloat(budget.toFixed(2)),
      total_spent: parseFloat(totalSpent.toFixed(2)),
      count: occurrences.length,
      pct_of_budget: pct,
      over: totalSpent > budget,
      account: bill.account,
      occurrences,
      type: "adhoc",
    };
  });

  // Bills summary totals (fixed bills only for paid/upcoming/overdue)
  const totalBillsDue = fixedBillsWithStatus.reduce((s,b)=>s+b.amount,0);
  const totalBillsPaid = fixedBillsWithStatus.filter(b=>b.status==="paid").reduce((s,b)=>s+b.amount,0);
  const totalBillsUpcoming = fixedBillsWithStatus.filter(b=>b.status==="upcoming").reduce((s,b)=>s+b.amount,0);
  const totalBillsOverdue = fixedBillsWithStatus.filter(b=>b.status==="overdue").reduce((s,b)=>s+b.amount,0);
  const billsPaidPct = totalBillsDue > 0 ? Math.round((totalBillsPaid/totalBillsDue)*100) : 0;

  // Calendar grid — 14 days, fixed bills on due dates + adhoc on actual charge dates
  const calendarDays = Array.from({ length: cycle.cycleDays }, (_, i) => {
    const dayDate = new Date(cycle.thisCycleStart.getTime() + i * 86400000);
    const dateStr = dayDate.toISOString().slice(0, 10);
    const isToday = dateStr === now.toISOString().slice(0, 10);

    // Fixed bills due on this day
    const fixedOnDay = fixedBillsWithStatus.filter(b => b.due_date === dateStr);

    // Adhoc occurrences on this day
    const adhocOnDay = adhocBillsData.flatMap(bill =>
      bill.occurrences
        .filter(o => o.date === dateStr)
        .map(o => ({
          name: bill.name,
          amount: o.amount,
          status: "adhoc",
          type: "adhoc",
        }))
    );

    return {
      date: dateStr,
      day_label: dayDate.toLocaleDateString("en-AU", {
        timeZone: "Australia/Sydney", weekday: "short",
      }),
      day_num: dayDate.getUTCDate(),
      is_today: isToday,
      is_past: dayDate < now && !isToday,
      bills: [...fixedOnDay, ...adhocOnDay],
    };
  });

  // Portfolio
  const priceRows = pricesRaw.slice(1).filter(r=>r[0]);
  const holdings = priceRows
    .filter(r => parseAmount(r[8]) > 0 && !String(r[6]||"").includes("ERROR"))
    .map(r => ({
      ticker: String(r[0]),
      name: String(r[1]||""),
      units: parseFloat(r[2])||0,
      price: parseFloat(r[6])||0,
      value: parseFloat(parseAmount(r[8]).toFixed(2)),
      cost: parseFloat(parseAmount(r[9]).toFixed(2)),
      pl: (() => { const raw=String(r[10]||"0"); const abs=parseAmount(raw); return raw.includes("-")?-abs:abs; })(),
      pl_pct: parseFloat(r[11])||0,
      change_24h: parseFloat(r[7])||0,
      platform: String(r[4]||""),
      asset_type: String(r[5]||""),
    }))
    .sort((a,b)=>b.value-a.value);

  const portfolioTotal = holdings.reduce((s,h)=>s+h.value,0);
  const portfolioCost = holdings.reduce((s,h)=>s+h.cost,0);
  const portfolioPL = portfolioTotal - portfolioCost;
  const portfolioPLPct = portfolioCost > 0 ? parseFloat(((portfolioPL/portfolioCost)*100).toFixed(1)) : 0;
  const topMovers = [...holdings]
    .filter(h=>h.change_24h!==0)
    .sort((a,b)=>Math.abs(b.change_24h)-Math.abs(a.change_24h))
    .slice(0,3)
    .map(h=>({ ticker:h.ticker, change:h.change_24h }));

  const updatedAEST = new Date(now.toLocaleString("en-AU",{timeZone:"Australia/Sydney"}));
  const updatedStr = updatedAEST.toLocaleString("en-AU",{
    weekday:"short",day:"numeric",month:"short",hour:"2-digit",minute:"2-digit",
  });

  const data = {
    meta: { updated: updatedStr, updated_iso: now.toISOString() },
    cycle: {
      day: cycle.daysElapsed + 1,
      total_days: cycle.cycleDays,
      days_remaining: cycle.daysRemaining,
      cycle_start: cycle.thisCycleStart.toISOString().slice(0,10),
    },
    discretionary: {
      spent: parseFloat(discretionaryTotal.toFixed(2)),
      budget: fnSpendBudget,
      remaining: parseFloat(discretionaryRemaining.toFixed(2)),
      projected: projectedDiscretionary,
      pct_used: pctUsed,
    },
    savings: {
      amount: parseFloat(actualSavings.toFixed(2)),
      target: fnSavingsTarget,
      rate_pct: savingsRate,
      target_rate_pct: savingsTargetPct,
      on_track: onTrackSavings,
    },
    spending: {
      categories: categoryData,
      mortgage: parseFloat(mortgageThisCycle.toFixed(2)),
      total_all_accounts: parseFloat(totalSpendThisCycle.toFixed(2)),
    },
    bills: {
      summary: {
        total_due: parseFloat(totalBillsDue.toFixed(2)),
        total_paid: parseFloat(totalBillsPaid.toFixed(2)),
        total_upcoming: parseFloat(totalBillsUpcoming.toFixed(2)),
        total_overdue: parseFloat(totalBillsOverdue.toFixed(2)),
        paid_pct: billsPaidPct,
      },
      fixed: fixedBillsWithStatus,
      adhoc: adhocBillsData,
      calendar: calendarDays,
    },
    balances: {
      accounts: balances,
      total: parseFloat(totalBalance.toFixed(2)),
    },
    portfolio: {
      total: parseFloat(portfolioTotal.toFixed(2)),
      cost: parseFloat(portfolioCost.toFixed(2)),
      pl: parseFloat(portfolioPL.toFixed(2)),
      pl_pct: portfolioPLPct,
      holdings,
      top_movers: topMovers,
    },
  };

  writeFileSync("data.json", JSON.stringify(data, null, 2));
  console.log(`✅ data.json written`);
  console.log(`   Fixed bills: ${fixedBillsWithStatus.length} due | ${fixedBillsWithStatus.filter(b=>b.status==="paid").length} paid`);
  console.log(`   Adhoc: ${adhocBillsData.map(b=>`${b.name}: ${b.count} charges $${b.total_spent}`).join(" | ")}`);
  console.log(`   Portfolio: $${portfolioTotal.toFixed(2)} | Discretionary: $${discretionaryTotal.toFixed(2)}/$${fnSpendBudget}`);
}

main().catch(err => { console.error("💥", err); process.exit(1); });
