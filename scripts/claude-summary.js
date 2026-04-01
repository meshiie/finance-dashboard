import { google } from "googleapis";

const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
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

function rowsToObjects(rows) {
  if (rows.length < 2) return [];
  const [headers, ...data] = rows;
  return data.map(row => Object.fromEntries(headers.map((h, i) => [h, row[i] ?? ""])));
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
  const d = (desc || "").toLowerCase();
  return GROCERY_MERCHANTS.some(m => d.includes(m));
}

function isMortgage(desc) {
  return (desc || "").toLowerCase().includes("withdrawal direct debit");
}

const CAT_MAP = {
  TRANSPORTATION: "Transport",
  MEDICAL: "Health & medical",
  PERSONAL_CARE: "Personal care & beauty",
  ENTERTAINMENT: "Entertainment",
  MERCHANDISE: "Shopping & clothing",
  RENT_AND_UTILITIES: "Utilities & bills",
  LOAN_PAYMENTS: "Insurance",
  HOME_IMPROVEMENT: "Home & garden",
  GOVERNMENT_AND_NON_PROFIT: "Govt & non-profit",
  SERVICES: "Services",
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

// ── Cycle bounds (pure UTC — no timezone manipulation) ────────────────────────
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

function isPaydayToday(nextPaydayStr, cycleDays) {
  return getCycleBounds(nextPaydayStr, cycleDays).daysElapsed === 0;
}

// ── Transaction parser ────────────────────────────────────────────────────────
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

// ── Main data gathering ───────────────────────────────────────────────────────
async function gatherData() {
  const [balancesRaw, pricesRaw, configRaw, budgetRaw,
    spend0524Raw, bills6660Raw, main1524Raw] = await Promise.all([
    readSheet("Balances!A:E"),
    readSheet("Prices!A:M"),
    readSheet("Config!A:B"),
    readSheet("Budget!A:C"),
    readSheet("Spend account (0524)!A:L"),
    readSheet("Bills account (6660)!A:L"),
    readSheet("Pramesh Singh (1524)!A:L"),
  ]);

  // Config
  const cfg = Object.fromEntries(
    (configRaw.slice(1) || []).filter(r => r[0]).map(r => [r[0], r[1]])
  );
  const fnIncome = parseFloat(cfg.fortnightly_income || 4215);
  const fnSpendBudget = parseFloat(cfg.fortnightly_spend_budget || 1000);
  const fnSavingsTarget = parseFloat(cfg.fortnightly_savings_target || 600);
  const savingsTargetPct = parseFloat(cfg.savings_target_pct || 14.2);
  const nextPayday = cfg.next_payday || "2026-04-08";
  const cycleDays = parseInt(cfg.pay_cycle_days || 14);

  const cycle = getCycleBounds(nextPayday, cycleDays);
  const now = new Date();

  // Balances
  const balances = rowsToObjects(balancesRaw)
    .filter(b => b["Current Balance"] && !isNaN(parseFloat(String(b["Current Balance"]).replace(/[$,]/g, ""))))
    .map(b => ({
      account: b.Account,
      balance: parseFloat(String(b["Current Balance"]).replace(/[$,]/g, "")) || 0,
    }));

  // Parse all transaction sheets
  const spend0524 = parseTxns(spend0524Raw);
  const bills6660 = parseTxns(bills6660Raw);
  const main1524 = parseTxns(main1524Raw);
  const allTxns = [...spend0524, ...bills6660, ...main1524];

  // ── Discretionary spend this cycle (Spend 0524 ONLY) ─────────────────────
  const discretionaryCats = buildCatTotals(spend0524, cycle.thisCycleStart);
  const discretionaryTotal = Object.values(discretionaryCats).reduce((a, b) => a + b, 0);
  const discretionaryRemaining = Math.max(0, fnSpendBudget - discretionaryTotal);
  const projectedDiscretionary = cycle.daysElapsed > 0
    ? (discretionaryTotal / cycle.daysElapsed) * cycle.cycleDays
    : 0;

  // Previous cycle discretionary (for fortnightly comparison)
  const prevDiscretionaryCats = buildCatTotals(spend0524, cycle.prevCycleStart, cycle.thisCycleStart);
  const prevDiscretionaryTotal = Object.values(prevDiscretionaryCats).reduce((a, b) => a + b, 0);

  // Biggest discretionary transaction this cycle
  const biggestThisCycle = spend0524
    .filter(t => t.direction === "debit" && t.date >= cycle.thisCycleStart && isRealSpend(t.cat, t.desc))
    .sort((a, b) => b.amount - a.amount)[0];

  // ── All-account spend this cycle ──────────────────────────────────────────
  const allCatsThisCycle = buildCatTotals(allTxns, cycle.thisCycleStart);
  const mortgageThisCycle = allCatsThisCycle["Mortgage"] || 0;
  const totalSpendThisCycle = Object.values(allCatsThisCycle).reduce((a, b) => a + b, 0);

  // ── Savings ───────────────────────────────────────────────────────────────
  const actualSavings = fnIncome - totalSpendThisCycle;
  const savingsRate = fnIncome > 0 ? ((actualSavings / fnIncome) * 100).toFixed(1) : "0";
  const onTrackSavings = actualSavings >= fnSavingsTarget;

  // ── Budget comparison (discretionary only, fortnightly basis) ─────────────
  const budgetObjs = rowsToObjects(budgetRaw).filter(b => b.Category);
  const budgetComparison = budgetObjs.map(b => {
    const fnBudget = parseFloat(b.Monthly_Budget || 0) / 2;
    const spent = discretionaryCats[b.Category] || 0;
    return {
      category: b.Category,
      spent,
      budget: fnBudget,
      variance: spent - fnBudget,
      over: spent > fnBudget,
    };
  }).filter(b => b.budget > 0 && b.category !== "Mortgage");

  // ── Yesterday's transactions (Spend 0524 only) ────────────────────────────
  const ydayStart = new Date(now);
  ydayStart.setUTCDate(ydayStart.getUTCDate() - 1);
  ydayStart.setUTCHours(0, 0, 0, 0);
  const ydayEnd = new Date(ydayStart.getTime() + 86400000);

  const yesterdayTxns = spend0524
    .filter(t =>
      t.direction === "debit" &&
      t.date >= ydayStart &&
      t.date < ydayEnd &&
      isRealSpend(t.cat, t.desc)
    )
    .sort((a, b) => b.amount - a.amount);

  // ── Uncategorised transactions this cycle (all accounts) ──────────────────
  const uncategorised = allTxns
    .filter(t =>
      t.direction === "debit" &&
      t.date >= cycle.thisCycleStart &&
      (t.cat === "" || t.cat === "nan" || !t.cat) &&
      !isMortgage(t.desc) &&
      t.amount > 1
    )
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 8);

  // ── Portfolio ─────────────────────────────────────────────────────────────
  const priceObjs = rowsToObjects(pricesRaw);
  const portfolioTotal = priceObjs
    .filter(p => p.Current_Value && p.Current_Value !== "ERROR")
    .reduce((s, p) => s + parseFloat(p.Current_Value || 0), 0);
  const portfolioCost = priceObjs.reduce((s, p) => s + parseFloat(p.Cost_Basis || 0), 0);
  const portfolioPL = portfolioTotal - portfolioCost;
  const portfolioPLPct = portfolioCost > 0 ? ((portfolioPL / portfolioCost) * 100).toFixed(1) : "0";
  const topMovers = priceObjs
    .filter(p => p.Change_24h_Pct && !["0", "0.0", "ERROR"].includes(String(p.Change_24h_Pct)))
    .sort((a, b) => Math.abs(parseFloat(b.Change_24h_Pct)) - Math.abs(parseFloat(a.Change_24h_Pct)))
    .slice(0, 3)
    .map(p => `${p.Ticker}: ${parseFloat(p.Change_24h_Pct) >= 0 ? "+" : ""}${parseFloat(p.Change_24h_Pct).toFixed(2)}%`);

  // AEST display time
  const nowAEST = new Date(now.toLocaleString("en-AU", { timeZone: "Australia/Sydney" }));

  return {
    now, nowAEST, cycle,
    balances,
    discretionaryCats, discretionaryTotal, discretionaryRemaining, projectedDiscretionary,
    prevDiscretionaryCats, prevDiscretionaryTotal,
    biggestThisCycle,
    allCatsThisCycle, mortgageThisCycle, totalSpendThisCycle,
    fnIncome, fnSpendBudget, fnSavingsTarget, savingsTargetPct,
    actualSavings, savingsRate, onTrackSavings,
    budgetComparison,
    yesterdayTxns,
    uncategorised,
    portfolioTotal, portfolioPL, portfolioPLPct, topMovers,
    isPayday: isPaydayToday(nextPayday, cycleDays),
  };
}

// ── Claude API ────────────────────────────────────────────────────────────────
async function askClaude(prompt, maxTokens = 500) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);
  return (await res.json()).content[0].text;
}

// ── Telegram ──────────────────────────────────────────────────────────────────
async function sendTelegram(message) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: "HTML" }),
  });
  if (!res.ok) throw new Error(`Telegram ${res.status}: ${await res.text()}`);
  console.log("✅ Telegram sent");
}

// ── Daily briefing prompt ─────────────────────────────────────────────────────
function buildDailyPrompt(d) {
  const pctUsed = d.fnSpendBudget > 0
    ? ((d.discretionaryTotal / d.fnSpendBudget) * 100).toFixed(0)
    : "0";
  const projected = d.projectedDiscretionary > 0
    ? `$${d.projectedDiscretionary.toFixed(0)} projected at current pace`
    : "first day of cycle — no projection yet";
  const overBudget = d.budgetComparison
    .filter(b => b.over)
    .map(b => `${b.category} ($${b.spent.toFixed(0)} vs $${b.budget.toFixed(0)} fortnightly budget)`)
    .join(", ") || "none — all on track";
  const topCats = Object.entries(d.allCatsThisCycle)
    .filter(([c]) => c !== "Mortgage")
    .sort(([, a], [, b]) => b - a)
    .slice(0, 4)
    .map(([c, a]) => `${c}: $${a.toFixed(0)}`)
    .join(", ");
  const bigTxn = d.biggestThisCycle
    ? `Biggest this fortnight: $${d.biggestThisCycle.amount.toFixed(2)} — ${d.biggestThisCycle.desc.slice(0, 50)}`
    : "No transactions yet this fortnight";
  const yday = d.yesterdayTxns.length > 0
    ? `Yesterday: ${d.yesterdayTxns.slice(0, 3).map(t => `$${t.amount.toFixed(2)} at ${t.desc.slice(0, 35)}`).join(", ")}`
    : "No spend recorded yesterday";
  const balanceSummary = d.balances
    .map(b => `${b.account}: $${b.balance.toLocaleString("en-AU", { minimumFractionDigits: 2 })}`)
    .join(" | ");

  // Uncategorised transactions section
  const uncatStr = d.uncategorised.length > 0
    ? `UNCATEGORISED TRANSACTIONS THIS CYCLE (need categories in Redbark):\n${d.uncategorised.map(t =>
        `  $${t.amount.toFixed(2)} — ${t.desc.slice(0, 55)} (${t.date.toISOString().slice(0, 10)})`
      ).join("\n")}`
    : "UNCATEGORISED: none this cycle ✅";

  return `You are Pramesh's direct personal finance assistant. Morning briefing — 5-6 sentences max, punchy, no fluff, no disclaimers.

FORTNIGHTLY CYCLE: Day ${d.cycle.daysElapsed + 1} of ${d.cycle.cycleDays} — ${d.cycle.daysRemaining} days remaining

DISCRETIONARY SPEND (Spend account only — budget $${d.fnSpendBudget}/fortnight):
  Spent: $${d.discretionaryTotal.toFixed(2)} (${pctUsed}% used) | Remaining: $${d.discretionaryRemaining.toFixed(2)} | ${projected}

${bigTxn}
${yday}

OVER BUDGET CATEGORIES: ${overBudget}
TOP SPEND CATEGORIES THIS CYCLE: ${topCats}
MORTGAGE THIS CYCLE: $${d.mortgageThisCycle.toFixed(2)}
TOTAL SPEND ALL ACCOUNTS: $${d.totalSpendThisCycle.toFixed(2)}

SAVINGS: $${d.actualSavings.toFixed(2)} vs $${d.fnSavingsTarget} target — ${d.onTrackSavings ? "ON TRACK ✅" : "BEHIND ⚠️"}
SAVINGS RATE: ${d.savingsRate}% vs ${d.savingsTargetPct}% target

BALANCES: ${balanceSummary}
PORTFOLIO: $${d.portfolioTotal.toLocaleString("en-AU", { minimumFractionDigits: 2 })} | All-time P&L: ${d.portfolioPL >= 0 ? "+" : ""}$${Math.abs(d.portfolioPL).toFixed(0)} (${d.portfolioPLPct}%) | Movers: ${d.topMovers.join(", ") || "markets closed"}

${uncatStr}

Write the briefing. Lead with discretionary spend status (% used, days left, projected end). Mention biggest transaction. Call out any over-budget categories by name. Give savings verdict. End with portfolio one-liner. Then on a new line, if there are uncategorised transactions list them plainly so Pramesh knows to fix them in Redbark. Plain text only — no markdown.`;
}

// ── Fortnightly payday prompt ─────────────────────────────────────────────────
function buildFortnightlyPrompt(d) {
  const totalDiff = d.discretionaryTotal - d.prevDiscretionaryTotal;
  const catChanges = Object.keys({ ...d.discretionaryCats, ...d.prevDiscretionaryCats })
    .map(cat => {
      const curr = d.discretionaryCats[cat] || 0;
      const prev = d.prevDiscretionaryCats[cat] || 0;
      const diff = curr - prev;
      const arrow = diff > 20 ? "▲" : diff < -20 ? "▼" : "→";
      return `${cat}: $${curr.toFixed(0)} ${arrow} (was $${prev.toFixed(0)}, ${diff >= 0 ? "+" : ""}$${diff.toFixed(0)})`;
    }).join("\n");

  const bigTxn = d.biggestThisCycle
    ? `$${d.biggestThisCycle.amount.toFixed(2)} at ${d.biggestThisCycle.desc.slice(0, 55)}`
    : "no major transactions";

  const uncatStr = d.uncategorised.length > 0
    ? `UNCATEGORISED (fix in Redbark):\n${d.uncategorised.map(t =>
        `  $${t.amount.toFixed(2)} — ${t.desc.slice(0, 55)} (${t.date.toISOString().slice(0, 10)})`
      ).join("\n")}`
    : "";

  return `You are Pramesh's personal finance coach. He just got paid — fortnightly pay summary. Direct, practical, 8-10 sentences max. No disclaimers.

FORTNIGHT COMPLETED:
  Fortnightly income: $${d.fnIncome.toLocaleString("en-AU", { minimumFractionDigits: 2 })}
  Total spend all accounts (incl. mortgage $${d.mortgageThisCycle.toFixed(0)}): $${d.totalSpendThisCycle.toFixed(2)}
  Discretionary (Spend account, budget $${d.fnSpendBudget}): $${d.discretionaryTotal.toFixed(2)} (${totalDiff >= 0 ? "+" : ""}$${totalDiff.toFixed(0)} vs last fortnight)
  Biggest transaction: ${bigTxn}
  Actual savings: $${d.actualSavings.toFixed(2)} vs $${d.fnSavingsTarget} target
  Savings rate: ${d.savingsRate}% vs ${d.savingsTargetPct}% target

CATEGORY BREAKDOWN — this fortnight vs last:
${catChanges}

${uncatStr}

Write the summary. Start with payday acknowledgement and overall verdict. Call out biggest transaction. Note 2-3 meaningful category shifts. Give 2-3 specific, actionable tips for next fortnight to hit the $${d.fnSavingsTarget} savings target. If there are uncategorised transactions, add a short note to fix them in Redbark. Encouraging but honest. Plain text only.`;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("🤖 Starting:", new Date().toISOString());

  const data = await gatherData();

  console.log(`📊 Day ${data.cycle.daysElapsed + 1}/${data.cycle.cycleDays} | Discretionary: $${data.discretionaryTotal.toFixed(2)}/$${data.fnSpendBudget} | Savings: $${data.actualSavings.toFixed(2)} | Portfolio: $${data.portfolioTotal.toFixed(2)}`);
  console.log(`🗂️  Uncategorised this cycle: ${data.uncategorised.length}`);
  console.log(`📅 Payday: ${data.isPayday}`);

  const timeStr = data.nowAEST.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" });
  const dateStr = data.nowAEST.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" });

  let summary, header;
  if (data.isPayday) {
    console.log("💸 Generating fortnightly payday summary...");
    summary = await askClaude(buildFortnightlyPrompt(data), 600);
    header = `💸 <b>Payday — Fortnight Review</b>`;
  } else {
    console.log("📋 Generating daily briefing...");
    summary = await askClaude(buildDailyPrompt(data), 550);
    header = `📊 <b>Morning Briefing</b>`;
  }

  await sendTelegram(`${header} · ${dateStr} ${timeStr}\n\n${summary}`);
  console.log("✅ Done:", new Date().toISOString());
}

main().catch(err => {
  console.error("💥 Fatal:", err);
  process.exit(1);
});
