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

function isGrocery(desc) {
  return GROCERY_MERCHANTS.some(m => (desc || "").toLowerCase().includes(m));
}

function isMortgage(desc) {
  return (desc || "").toLowerCase().includes("withdrawal direct debit");
}

const CAT_MAP = {
  TRANSPORTATION: "Transport", MEDICAL: "Health & medical",
  PERSONAL_CARE: "Personal care & beauty", ENTERTAINMENT: "Entertainment",
  MERCHANDISE: "Shopping & clothing", RENT_AND_UTILITIES: "Utilities & bills",
  LOAN_PAYMENTS: "Insurance", HOME_IMPROVEMENT: "Home & garden",
  GOVERNMENT_AND_NON_PROFIT: "Govt & non-profit", SERVICES: "Services",
};

function tagTxn(cat, desc) {
  if (isMortgage(desc)) return "Mortgage";
  if (cat === "FOOD_AND_DRINK") return isGrocery(desc) ? "Groceries" : "Eating out & cafes";
  return CAT_MAP[cat] || null;
}

const SKIP_CATS = new Set(["TRANSFER_OUT", "TRANSFER_IN", "INCOME", "nan", ""]);

function isRealSpend(cat, desc) {
  if (isMortgage(desc)) return true;
  return !SKIP_CATS.has(cat);
}

// Pure UTC cycle bounds
function getCycleBounds(nextPaydayStr, cycleDays) {
  const now = new Date();
  const nextPayday = new Date(nextPaydayStr + "T00:00:00Z");
  const msDay = 86400000;
  const daysSince = Math.floor((now - nextPayday) / msDay);
  const offset = daysSince < 0
    ? Math.ceil(daysSince / cycleDays) - 1
    : Math.floor(daysSince / cycleDays);
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

// Sanitise account label — remove personal name, keep friendly label
function sanitiseAccountLabel(rawLabel) {
  const label = String(rawLabel || "");
  if (label.toLowerCase().includes("bill")) return "Bills account";
  if (label.toLowerCase().includes("spend")) return "Spend account";
  // AMP offset accounts — use last 4 digits to distinguish
  const match = label.match(/\((\d+)\)/);
  if (match) {
    const last4 = match[1].slice(-4);
    if (last4 === "4252") return "Offset savings";
    if (last4 === "1524") return "Main offset";
    return `Account (${last4})`;
  }
  return "Account";
}

async function main() {
  console.log("📊 Generating dashboard data:", new Date().toISOString());

  // Read Config first to get dynamic sheet names
  const configRaw = await readSheet("Config!A:B");
  const cfg = Object.fromEntries(
    (configRaw.slice(1) || []).filter(r => r[0]).map(r => [r[0], r[1]])
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

  // Read all sheets
  const [balancesRaw, pricesRaw, budgetRaw, spend0524Raw, bills6660Raw, main1524Raw] = await Promise.all([
    readSheet("Balances!A:E"),
    readSheet("Prices!A:M"),
    readSheet("Budget!A:C"),
    readSheet(`${spendSheet}!A:L`),
    readSheet(`${billsSheet}!A:L`),
    readSheet(`${offsetSheet}!A:L`),
  ]);

  // Balances (sanitised labels)
  const balanceRows = balancesRaw.slice(1).filter(r => r[0] && r[1]);
  const balances = balanceRows.map(r => ({
    label: sanitiseAccountLabel(r[0]),
    amount: parseAmount(r[1]),
  })).filter(b => b.amount > 0);
  const totalBalance = balances.reduce((s, b) => s + b.amount, 0);

  // Parse transactions
  const spend0524 = parseTxns(spend0524Raw);
  const bills6660 = parseTxns(bills6660Raw);
  const main1524 = parseTxns(main1524Raw);
  const allTxns = [...spend0524, ...bills6660, ...main1524];

  // Discretionary this cycle (Spend 0524 only)
  const discretionaryCats = buildCatTotals(spend0524, cycle.thisCycleStart);
  const discretionaryTotal = Object.values(discretionaryCats).reduce((a, b) => a + b, 0);
  const discretionaryRemaining = Math.max(0, fnSpendBudget - discretionaryTotal);
  const projectedDiscretionary = cycle.daysElapsed > 0
    ? Math.round((discretionaryTotal / cycle.daysElapsed) * cycle.cycleDays)
    : 0;
  const pctUsed = Math.round((discretionaryTotal / fnSpendBudget) * 100);

  // All-account spend this cycle
  const allCatsThisCycle = buildCatTotals(allTxns, cycle.thisCycleStart);
  const mortgageThisCycle = allCatsThisCycle["Mortgage"] || 0;
  const totalSpendThisCycle = Object.values(allCatsThisCycle).reduce((a, b) => a + b, 0);

  // Savings
  const actualSavings = fnIncome - totalSpendThisCycle;
  const savingsRate = fnIncome > 0 ? parseFloat(((actualSavings / fnIncome) * 100).toFixed(1)) : 0;
  const onTrackSavings = actualSavings >= fnSavingsTarget;

  // Budget comparison per category (fortnightly basis)
  const budgetObjs = budgetRaw.slice(1).filter(r => r[0] && r[2]).map(r => ({
    category: String(r[0]).trim(),
    fnBudget: parseFloat(r[2]) / 2,
  }));

  const categoryData = budgetObjs
    .filter(b => b.category !== "Mortgage" && b.fnBudget > 0)
    .map(b => ({
      name: b.category,
      spent: parseFloat((discretionaryCats[b.category] || 0).toFixed(2)),
      budget: parseFloat(b.fnBudget.toFixed(2)),
      over: (discretionaryCats[b.category] || 0) > b.fnBudget,
    }))
    .sort((a, b) => b.spent - a.spent);

  // Portfolio
  const priceRows = pricesRaw.slice(1).filter(r => r[0]);
  const holdings = priceRows
    .filter(r => {
      const cv = parseAmount(r[8]);
      const err = String(r[6] || "").includes("ERROR");
      return cv > 0 && !err;
    })
    .map(r => ({
      ticker: String(r[0]),
      name: String(r[1] || ""),
      units: parseFloat(r[2]) || 0,
      price: parseFloat(r[6]) || 0,
      value: parseFloat(parseAmount(r[8]).toFixed(2)),
      cost: parseFloat(parseAmount(r[9]).toFixed(2)),
      pl: parseFloat(parseAmount(r[10])),
      pl_negative: String(r[10] || "").includes("-"),
      pl_pct: parseFloat(r[11]) || 0,
      change_24h: parseFloat(r[7]) || 0,
      platform: String(r[4] || ""),
      last_updated: String(r[12] || ""),
    }))
    .map(h => ({ ...h, pl: h.pl_negative ? -h.pl : h.pl }))
    .sort((a, b) => b.value - a.value);

  const portfolioTotal = holdings.reduce((s, h) => s + h.value, 0);
  const portfolioCost = holdings.reduce((s, h) => s + h.cost, 0);
  const portfolioPL = portfolioTotal - portfolioCost;
  const portfolioPLPct = portfolioCost > 0
    ? parseFloat(((portfolioPL / portfolioCost) * 100).toFixed(1)) : 0;

  const topMovers = [...holdings]
    .filter(h => h.change_24h !== 0)
    .sort((a, b) => Math.abs(b.change_24h) - Math.abs(a.change_24h))
    .slice(0, 3)
    .map(h => ({ ticker: h.ticker, change: h.change_24h }));

  // Last updated (AEST)
  const updatedAEST = new Date(now.toLocaleString("en-AU", { timeZone: "Australia/Sydney" }));
  const updatedStr = updatedAEST.toLocaleString("en-AU", {
    weekday: "short", day: "numeric", month: "short",
    hour: "2-digit", minute: "2-digit",
  });

  // Build sanitised data.json
  const data = {
    meta: {
      updated: updatedStr,
      updated_iso: now.toISOString(),
    },
    cycle: {
      day: cycle.daysElapsed + 1,
      total_days: cycle.cycleDays,
      days_remaining: cycle.daysRemaining,
      cycle_start: cycle.thisCycleStart.toISOString().slice(0, 10),
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
  console.log(`✅ data.json written — portfolio: $${portfolioTotal.toFixed(2)}, discretionary: $${discretionaryTotal.toFixed(2)}/$${fnSpendBudget}`);
}

main().catch(err => {
  console.error("💥", err);
  process.exit(1);
});
