import { google } from "googleapis";

const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

async function readSheet(range) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range });
  return res.data.values || [];
}

async function appendSheet(range, values) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values },
  });
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
    console.warn("⚠️  No Last Updated timestamps — proceeding anyway");
    return { fresh: true };
  }

  const mostRecent = new Date(Math.max(...timestamps.map(d => d.getTime())));
  const now = new Date();
  const ageHours = (now.getTime() - mostRecent.getTime()) / (1000 * 60 * 60);
  const lastSyncedStr = mostRecent.toLocaleString("en-AU", {
    timeZone: "Australia/Sydney", weekday: "short", day: "numeric",
    month: "short", hour: "2-digit", minute: "2-digit",
  });
  console.log(`🕐 Redbark last synced: ${lastSyncedStr} (${ageHours.toFixed(1)}h ago)`);
  return { fresh: ageHours <= 24, ageHours: ageHours.toFixed(1), lastSyncedStr };
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
function isAuthorisation(desc) {
  const d = (desc||"").toUpperCase();
  return d.includes("AUTHORISATION") || d.includes("AUTHORIZATION");
}

const CAT_MAP = {
  TRANSPORTATION:"Transport", MEDICAL:"Health & medical",
  PERSONAL_CARE:"Personal care & beauty", ENTERTAINMENT:"Entertainment",
  MERCHANDISE:"Shopping & clothing", RENT_AND_UTILITIES:"Utilities & bills",
  LOAN_PAYMENTS:"Insurance", HOME_IMPROVEMENT:"Home & garden",
  GOVERNMENT_AND_NON_PROFIT:"Govt & non-profit", SERVICES:"Services",
};

function resolveCategory(cat, desc, overrides) {
  if (isMortgage(desc)) return "Mortgage";
  const d = (desc||"").toLowerCase();
  for (const ov of overrides) {
    if (ov.keyword && d.includes(ov.keyword.toLowerCase())) return ov.category;
  }
  if (cat === "FOOD_AND_DRINK") return isGrocery(desc) ? "Groceries" : "Eating out & cafes";
  return CAT_MAP[cat] || null;
}

const SKIP_CATS = new Set(["TRANSFER_OUT","TRANSFER_IN","INCOME","nan",""]);

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

function isPaydayToday(nextPaydayStr, cycleDays) {
  return getCycleBounds(nextPaydayStr, cycleDays).daysElapsed === 0;
}

// ── Transaction parser — excludes AUTHORISATION pre-auth holds ────────────────
function parseTxns(rows) {
  return rows.slice(1).map(row => ({
    date: new Date(row[1]),
    desc: String(row[2]||""),
    amount: parseAmount(row[3]),
    direction: String(row[5]||"").toLowerCase(),
    cat: String(row[6]||"").trim(),
  })).filter(t =>
    !isNaN(t.date.getTime()) &&
    !isAuthorisation(t.desc)
  );
}

function buildCatTotalsSimple(txns, from, to, overrides) {
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
    const resolved = resolveCategory(t.cat, t.desc, overrides);
    if (!resolved || resolved === "skip") continue;
    const hasOverride = overrides.some(ov => ov.keyword && (t.desc||"").toLowerCase().includes(ov.keyword.toLowerCase()));
    if (SKIP_CATS.has(t.cat) && !hasOverride && !isMortgage(t.desc)) continue;
    out[resolved] = (out[resolved]||0) + t.amount;
  }
  return out;
}

// ── Auto-categorisation ───────────────────────────────────────────────────────
function findUncategorisedTxns(allTxns, cycleStart, overrides) {
  const existingKeywords = overrides.map(ov => ov.keyword.toLowerCase());
  return allTxns.filter(t => {
    if (t.direction !== "debit") return false;
    if (t.date < cycleStart) return false;
    if (isMortgage(t.desc) || isAuthorisation(t.desc)) return false;
    if (t.amount <= 1) return false;
    const d = t.desc.toLowerCase();
    if (existingKeywords.some(k => k && d.includes(k))) return false;
    if (t.cat === "" || t.cat === "nan" || !t.cat) return true;
    if (t.cat === "TRANSFER_OUT") return true;
    return false;
  });
}

function deduplicateByKeyword(txns) {
  const seen = new Set();
  return txns.filter(t => {
    const key = t.desc.slice(0, 30).toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function autoCategorise(txns, overrides) {
  if (txns.length === 0) return [];
  const unique = deduplicateByKeyword(txns);
  if (unique.length === 0) return [];

  const validCategories = [
    "Eating out & cafes","Groceries","Transport","Health & medical",
    "Personal care & beauty","Entertainment","Shopping & clothing",
    "Utilities & bills","Insurance","Home & garden","Govt & non-profit",
    "Services","skip"
  ];

  const prompt = `You are categorising Australian bank transactions for a personal finance dashboard.

VALID CATEGORIES: ${validCategories.join(", ")}
Use "skip" for: personal transfers to friends/family, transfers between own accounts, non-spend items.

TRANSACTIONS TO CATEGORISE:
${unique.map((t,i) => `${i+1}. "${t.desc}" — $${t.amount.toFixed(2)} (tag: ${t.cat||"blank"})`).join("\n")}

Respond ONLY with a JSON array, no other text:
[{"index":1,"keyword":"keyword here","category":"Category Name","notes":"brief reason"},...]

Rules:
- keyword must match this AND similar future transactions
- PayID transfers to names: use the name (e.g. "James Smith")
- Merchants: use core name (e.g. "PILATES STUDIO")
- Ambiguous or personal: use "skip"`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1000, messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) throw new Error(`Claude API ${res.status}`);
    const data = await res.json();
    const clean = data.content[0].text.trim().replace(/```json|```/g, "").trim();
    const suggestions = JSON.parse(clean);
    return suggestions
      .filter(s => s.keyword && s.category && validCategories.includes(s.category))
      .map(s => ({ keyword: String(s.keyword).trim(), category: String(s.category).trim(), notes: String(s.notes||"").trim() }));
  } catch (err) {
    console.error("Auto-categorisation failed:", err.message);
    return [];
  }
}

async function writeOverrides(newOverrides) {
  if (newOverrides.length === 0) return;
  const today = new Date().toLocaleDateString("en-AU", {
    timeZone: "Australia/Sydney", day: "numeric", month: "short", year: "numeric",
  });
  await appendSheet("Overrides!A:E", newOverrides.map(o => [o.keyword, o.category, o.notes, "YES", today]));
  console.log(`✅ Wrote ${newOverrides.length} new overrides to sheet`);
}

// ── Telegram + Claude ─────────────────────────────────────────────────────────
async function sendTelegram(message) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: "HTML" }),
  });
  if (!res.ok) throw new Error(`Telegram ${res.status}: ${await res.text()}`);
  console.log("✅ Telegram sent");
}

async function askClaude(prompt, maxTokens=500) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);
  return (await res.json()).content[0].text;
}

// ── Data gathering ────────────────────────────────────────────────────────────
async function gatherData() {
  const freshness = await checkDataFreshness();
  if (!freshness.fresh) {
    const msg = `⚠️ <b>Redbark sync alert</b>\n\nData hasn't updated in <b>${freshness.ageHours}h</b>.\nLast synced: ${freshness.lastSyncedStr}\n\n👉 <a href="https://app.redbark.co">Check Redbark</a>`;
    await sendTelegram(msg);
    console.error("❌ Stale data — aborting");
    process.exit(0);
  }
  console.log(`✅ Data fresh — ${freshness.ageHours}h ago`);

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

  const overrides = overridesRaw.slice(1)
    .filter(r => r[0] && r[1])
    .map(r => ({ keyword: String(r[0]).trim(), category: String(r[1]).trim() }));
  console.log(`📋 ${overrides.length} overrides loaded`);

  const balances = balancesRaw.slice(1)
    .filter(r=>r[0]&&r[1])
    .map(r=>({ account:String(r[0]), balance:parseAmount(r[1]) }))
    .filter(b=>b.balance>0);

  const spend0524 = parseTxns(spend0524Raw);
  const bills6660 = parseTxns(bills6660Raw);
  const main1524 = parseTxns(main1524Raw);
  const allTxns = [...spend0524,...bills6660,...main1524];

  // Auto-categorisation
  const toReview = findUncategorisedTxns(allTxns, cycle.thisCycleStart, overrides);
  console.log(`🔍 ${toReview.length} transactions need categorisation`);
  let newOverrides = [];
  let autoCatSummary = "";
  if (toReview.length > 0) {
    newOverrides = await autoCategorise(toReview, overrides);
    if (newOverrides.length > 0) {
      await writeOverrides(newOverrides);
      overrides.push(...newOverrides.map(o => ({ keyword:o.keyword, category:o.category })));
      autoCatSummary = `\n\n🤖 <b>Auto-categorised ${newOverrides.length} transaction${newOverrides.length===1?"":"s"}:</b>\n${newOverrides.map(o=>`  • ${o.keyword} → ${o.category==="skip"?"excluded (personal)":o.category}`).join("\n")}\n<i>Check Overrides tab to edit</i>`;
    }
  }

  // Spend
  const discretionaryCatsRaw = buildCatTotalsSimple(spend0524, cycle.thisCycleStart, null, overrides);
  const totalReimbursed = parseFloat((discretionaryCatsRaw["__reimbursements__"] || 0).toFixed(2));
  delete discretionaryCatsRaw["__reimbursements__"];
  const discretionaryCats = discretionaryCatsRaw;
  const discretionaryGross = Object.values(discretionaryCats).reduce((a,b)=>a+b,0);
  const discretionaryTotal = Math.max(0, discretionaryGross - totalReimbursed);
  const discretionaryRemaining = Math.max(0, fnSpendBudget-discretionaryTotal);
  const projectedDiscretionary = cycle.daysElapsed>0
    ? (discretionaryTotal/cycle.daysElapsed)*cycle.cycleDays : 0;

  const prevDiscretionaryCats = buildCatTotalsSimple(spend0524, cycle.prevCycleStart, cycle.thisCycleStart, overrides);
  const prevDiscretionaryTotal = Object.values(prevDiscretionaryCats).reduce((a,b)=>a+b,0);

  const allCatsThisCycle = buildCatTotalsSimple(allTxns, cycle.thisCycleStart, null, overrides);
  const mortgageThisCycle = main1524
    .filter(t=>t.direction==="debit"&&t.date>=cycle.thisCycleStart&&isMortgage(t.desc))
    .reduce((s,t)=>s+t.amount,0);
  allCatsThisCycle["Mortgage"] = mortgageThisCycle;
  const totalSpendThisCycle = Object.values(allCatsThisCycle).reduce((a,b)=>a+b,0);

  const actualSavings = fnIncome-totalSpendThisCycle;
  const savingsRate = fnIncome>0?((actualSavings/fnIncome)*100).toFixed(1):"0";
  const onTrackSavings = actualSavings>=fnSavingsTarget;

  const budgetComparison = budgetRaw.slice(1).filter(r=>r[0]&&r[2])
    .map(r=>({ category:String(r[0]).trim(), budget:parseFloat(r[2])/2 }))
    .filter(b=>b.category!=="Mortgage"&&b.budget>0)
    .map(b=>({ category:b.category, spent:discretionaryCats[b.category]||0, budget:b.budget, over:(discretionaryCats[b.category]||0)>b.budget }));

  // Top 3 transactions (excl. mortgage + authorisations — already filtered)
  const top3Txns = allTxns
    .filter(t => {
      if (t.direction!=="debit"||t.date<cycle.thisCycleStart) return false;
      if (isMortgage(t.desc)) return false;
      const resolved = resolveCategory(t.cat, t.desc, overrides);
      return resolved && resolved !== "skip";
    })
    .sort((a,b)=>b.amount-a.amount)
    .slice(0,3);

  // Yesterday
  const ydayStart = new Date(now); ydayStart.setUTCDate(ydayStart.getUTCDate()-1); ydayStart.setUTCHours(0,0,0,0);
  const ydayEnd = new Date(ydayStart.getTime()+86400000);

  // Still uncategorised after auto-cat
  const stillUncategorised = allTxns.filter(t => {
    if (t.direction!=="debit"||t.date<cycle.thisCycleStart||t.amount<=1) return false;
    if (isMortgage(t.desc)||isAuthorisation(t.desc)) return false;
    const hasOverride = overrides.some(ov=>ov.keyword&&(t.desc||"").toLowerCase().includes(ov.keyword.toLowerCase()));
    if (hasOverride) return false;
    return t.cat===""||t.cat==="nan"||!t.cat||t.cat==="TRANSFER_OUT";
  }).slice(0,5);

  // Adhoc alerts
  const billsSchedule = billsScheduleRaw.slice(1).filter(r=>r[0]).map(r=>({
    name:String(r[0]||"").trim(), amount:parseFloat(r[1])||0,
    frequency:String(r[2]||"").trim().toLowerCase(),
    match_keyword:String(r[5]||"").trim(), active:String(r[6]||"").trim().toUpperCase(),
  }));
  const newAdhocCharges = [];
  for (const bill of billsSchedule.filter(b=>b.frequency==="adhoc"&&b.active==="YES")) {
    const kw = bill.match_keyword.toLowerCase();
    const newCharges = allTxns.filter(t=>t.direction==="debit"&&t.date>=ydayStart&&t.date<ydayEnd&&t.desc.toLowerCase().includes(kw));
    if (!newCharges.length) continue;
    const cycleTotal = allTxns.filter(t=>t.direction==="debit"&&t.date>=cycle.thisCycleStart&&t.desc.toLowerCase().includes(kw)).reduce((s,t)=>s+t.amount,0);
    for (const c of newCharges) newAdhocCharges.push({ bill_name:bill.name, charge_amount:c.amount, cycle_total:parseFloat(cycleTotal.toFixed(2)), budget:bill.amount, over:cycleTotal>bill.amount });
  }

  // Portfolio
  const priceObjs = pricesRaw.slice(1).filter(r=>r[0]).map(r=>({ Ticker:r[0], Change_24h_Pct:r[7], Current_Value:r[8], Cost_Basis:r[9] }));
  const portfolioTotal = priceObjs.filter(p=>p.Current_Value&&p.Current_Value!=="ERROR").reduce((s,p)=>s+parseFloat(p.Current_Value||0),0);
  const portfolioCost = priceObjs.reduce((s,p)=>s+parseFloat(p.Cost_Basis||0),0);
  const portfolioPL = portfolioTotal-portfolioCost;
  const portfolioPLPct = portfolioCost>0?((portfolioPL/portfolioCost)*100).toFixed(1):"0";
  const topMovers = priceObjs
    .filter(p=>p.Change_24h_Pct&&!["0","0.0","ERROR"].includes(String(p.Change_24h_Pct)))
    .sort((a,b)=>Math.abs(parseFloat(b.Change_24h_Pct))-Math.abs(parseFloat(a.Change_24h_Pct)))
    .slice(0,3).map(p=>({ ticker:p.Ticker, change:parseFloat(p.Change_24h_Pct) }));

  return {
    now, cycle, balances,
    discretionaryCats, discretionaryTotal, discretionaryRemaining, projectedDiscretionary,
    totalReimbursed,
    prevDiscretionaryCats, prevDiscretionaryTotal,
    top3Txns, allCatsThisCycle, mortgageThisCycle, totalSpendThisCycle,
    fnIncome, fnSpendBudget, fnSavingsTarget, savingsTargetPct,
    actualSavings, savingsRate, onTrackSavings, budgetComparison,
    stillUncategorised, newAdhocCharges,
    autoCatSummary, newOverridesCount: newOverrides.length,
    portfolioTotal, portfolioPL, portfolioPLPct, topMovers,
    isPayday: isPaydayToday(nextPayday, cycleDays),
  };
}

// ── Daily message — data-led, no Claude prose ─────────────────────────────────
function buildDailyMessage(d) {
  // Spend bar
  const pct = Math.min(d.fnSpendBudget>0?Math.round((d.discretionaryTotal/d.fnSpendBudget)*100):0,100);
  const bar = "▓".repeat(Math.round(pct/10)) + "░".repeat(10-Math.round(pct/10));
  const barIcon = pct>=100?"🔴":pct>=75?"🟡":"🟢";

  // Projected
  const projected = d.projectedDiscretionary>0
    ?`$${Math.round(d.projectedDiscretionary).toLocaleString("en-AU")} projected`
    :"first day of cycle";
  const projOver = d.projectedDiscretionary>d.fnSpendBudget
    ?` ⚠️ +$${Math.round(d.projectedDiscretionary-d.fnSpendBudget)} over`:"";

  // Recommended per day
  const daysLeft = d.cycle.daysRemaining;
  const recPerDay = daysLeft>0?Math.floor(d.discretionaryRemaining/daysLeft):0;
  const perDayIcon = recPerDay<20?"🔴":recPerDay<50?"🟡":"✅";

  // Top 3 table
  const rankEmoji = ["1️⃣","2️⃣","3️⃣"];
  const top3Lines = d.top3Txns.length>0
    ?d.top3Txns.map((t,i)=>`${rankEmoji[i]} $${t.amount.toFixed(2).padStart(7)}  ${t.desc.slice(0,30)}`).join("\n")
    :"No transactions yet this cycle";

  // Categories
  const budgetMap = Object.fromEntries(d.budgetComparison.map(b=>[b.category,b.budget]));
  const catLines = Object.entries(d.allCatsThisCycle)
    .filter(([c])=>c!=="Mortgage")
    .sort(([,a],[,b])=>b-a).slice(0,5)
    .map(([name,spent])=>{
      const budget = budgetMap[name];
      const over = budget&&spent>budget?" 🔴":"";
      const budgetStr = budget?`/ $${Math.round(budget)}`:"";
      const nameShort = name.length>20?name.slice(0,19)+"…":name;
      return `  ${nameShort.padEnd(21)} $${Math.round(spent).toString().padStart(4)}  ${budgetStr}${over}`;
    }).join("\n");

  // Portfolio movers
  const moverStr = d.topMovers.length>0
    ?d.topMovers.map(m=>`${m.change>=0?"📈":"📉"} ${m.ticker} ${m.change>=0?"+":""}${m.change.toFixed(2)}%`).join("  ")
    :"markets closed";

  const savIcon = d.onTrackSavings?"✅":"⚠️";

  const uncatNote = d.stillUncategorised.length>0
    ?`\n\n⚠️ <b>UNCATEGORISED (${d.stillUncategorised.length})</b>\n<code>${d.stillUncategorised.map(t=>`  $${t.amount.toFixed(2).padStart(7)}  ${t.desc.slice(0,35)}`).join("\n")}</code>`
    :"";

  const reimbursedLine = d.totalReimbursed > 0
    ? `\n↩️ Reimbursements netted: -$${d.totalReimbursed.toFixed(2)}`
    : "";

  return `💳 <b>SPEND</b>  $${Math.round(d.discretionaryTotal).toLocaleString("en-AU")} of $${d.fnSpendBudget.toLocaleString("en-AU")}  ${barIcon} ${pct}%
<code>${bar}</code>
${daysLeft} days left  ·  ${projected}${projOver}${reimbursedLine}
💡 Rec. <b>$${recPerDay}/day</b>  ${perDayIcon}

🧾 <b>TOP 3 THIS CYCLE</b>
<code>${top3Lines}</code>

📊 <b>CATEGORIES</b>
<code>${catLines}
  ${"─".repeat(36)}
  Mortgage              $${Math.round(d.mortgageThisCycle).toString().padStart(4)}
  Total all accounts  $${Math.round(d.totalSpendThisCycle).toLocaleString("en-AU")}</code>

💰 <b>SAVINGS</b>  $${Math.round(d.actualSavings).toLocaleString("en-AU")} banked  ${savIcon}
${d.savingsRate}% rate  ·  target ${d.savingsTargetPct}%

🏦 <b>BALANCES</b>
<code>${d.balances.map(b=>`  ${b.account.slice(0,20).padEnd(20)}  $${b.balance.toLocaleString("en-AU",{minimumFractionDigits:2})}`).join("\n")}</code>

📈 <b>PORTFOLIO</b>  $${Math.round(d.portfolioTotal).toLocaleString("en-AU")}  ·  ${d.portfolioPL>=0?"+":""}${d.portfolioPLPct}% all-time
${moverStr}${d.autoCatSummary}${uncatNote}`;
}

// ── Fortnightly prompt — Claude narrative ─────────────────────────────────────
function buildFortnightlyPrompt(d) {
  const totalDiff = d.discretionaryTotal-d.prevDiscretionaryTotal;
  const catChanges = Object.keys({...d.discretionaryCats,...d.prevDiscretionaryCats})
    .map(cat=>{const curr=d.discretionaryCats[cat]||0,prev=d.prevDiscretionaryCats[cat]||0,diff=curr-prev;return `${cat}: $${curr.toFixed(0)} ${diff>20?"▲":diff<-20?"▼":"→"} (was $${prev.toFixed(0)}, ${diff>=0?"+":""}$${diff.toFixed(0)})`;}).join("\n");
  const bigTxn = d.top3Txns[0]?`$${d.top3Txns[0].amount.toFixed(2)} at ${d.top3Txns[0].desc.slice(0,55)}`:"no major transactions";

  return `You are Pramesh's personal finance coach. He just got paid — fortnightly summary. Direct, practical, 8-10 sentences, no disclaimers.

FORTNIGHT COMPLETED:
  Income: $${d.fnIncome.toLocaleString("en-AU",{minimumFractionDigits:2})}
  Total spend incl. mortgage ($${Math.round(d.mortgageThisCycle)}): $${d.totalSpendThisCycle.toFixed(2)}
  Discretionary (budget $${d.fnSpendBudget}): $${d.discretionaryTotal.toFixed(2)} (${totalDiff>=0?"+":""}$${totalDiff.toFixed(0)} vs last fortnight)
  Biggest transaction: ${bigTxn}
  Savings: $${d.actualSavings.toFixed(2)} vs $${d.fnSavingsTarget} target | Rate: ${d.savingsRate}%

CATEGORY BREAKDOWN this vs last fortnight:
${catChanges}

Write: pay acknowledgement + verdict. Biggest transaction. 2-3 meaningful category changes. 2-3 specific tips for next fortnight. Plain text only.`;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("🤖 Starting:", new Date().toISOString());
  const data = await gatherData();

  console.log(`📊 Day ${data.cycle.daysElapsed+1}/${data.cycle.cycleDays} | Spend: $${data.discretionaryTotal.toFixed(2)}/$${data.fnSpendBudget} | Savings: $${data.actualSavings.toFixed(2)}`);
  console.log(`🚗 Adhoc: ${data.newAdhocCharges.length} | 🤖 Auto-cat: ${data.newOverridesCount} | 📅 Payday: ${data.isPayday}`);

  const timeStr = data.now.toLocaleTimeString("en-AU",{timeZone:"Australia/Sydney",hour:"2-digit",minute:"2-digit"});
  const dateStr = data.now.toLocaleDateString("en-AU",{timeZone:"Australia/Sydney",weekday:"short",day:"numeric",month:"short"});
  const dashUrl = "https://meshiie.github.io/finance-dashboard";

  // Adhoc alerts
  if (data.newAdhocCharges.length>0) {
    const lines = data.newAdhocCharges.map(c=>`🚗 <b>${c.bill_name}</b>: $${c.charge_amount.toFixed(2)}\n${c.over?`⚠️ Over $${c.budget} budget (total: $${c.cycle_total.toFixed(2)})`:`Running total: $${c.cycle_total.toFixed(2)} of $${c.budget} budget`}`).join("\n\n");
    await sendTelegram(`⚡ <b>Adhoc charge detected</b> · ${dateStr} ${timeStr}\n\n${lines}\n\n📱 <a href="${dashUrl}">Open dashboard</a>`);
  }

  // Daily or fortnightly
  if (data.isPayday) {
    console.log("💸 Generating fortnightly summary...");
    const summary = await askClaude(buildFortnightlyPrompt(data), 600);
    await sendTelegram(`💸 <b>Payday — Fortnight Review</b> · ${dateStr} ${timeStr}\n\n${summary}${data.autoCatSummary}\n\n📱 <a href="${dashUrl}">Open dashboard</a>`);
  } else {
    console.log("📋 Building data-led daily briefing...");
    const message = buildDailyMessage(data);
    await sendTelegram(`📊 <b>Morning Briefing</b> · ${dateStr} ${timeStr}\n\n${message}\n\n📱 <a href="${dashUrl}">Open dashboard</a>`);
  }

  console.log("✅ Done:", new Date().toISOString());
}

main().catch(err => { console.error("💥", err); process.exit(1); });
