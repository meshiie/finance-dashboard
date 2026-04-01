import { google } from "googleapis";

// ── Auth ────────────────────────────────────────────────────────────────────
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

// ── Helpers ───────────────────────────────────────────────────────────────────
async function readSheet(range) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range,
  });
  return res.data.values || [];
}

function rowsToObjects(rows) {
  if (rows.length < 2) return [];
  const headers = rows[0];
  return rows.slice(1).map(row =>
    Object.fromEntries(headers.map((h, i) => [h, row[i] ?? ""]))
  );
}

// Parse Redbark amount — handles both "$12.83" and "$(609.82)" formats
function parseAmount(raw, direction) {
  if (!raw) return 0;
  const clean = raw.replace(/[$,\s]/g, "").replace(/[()]/g, "");
  const num = parseFloat(clean) || 0;
  return direction === "debit" ? -Math.abs(num) : Math.abs(num);
}

// ── Data gathering ────────────────────────────────────────────────────────────
async function gatherFinancialSnapshot() {
  const [balances, prices, spendRows, billsRows, config, budget] = await Promise.all([
    readSheet("Balances!A:E"),
    readSheet("Prices!A:M"),
    readSheet("Spend account (0524)!A:L"),
    readSheet("Bills account (6660)!A:L"),
    readSheet("Config!A:B"),
    readSheet("Budget!A:C"),
  ]);

  // Config
  const configMap = Object.fromEntries((config.slice(1) || []).map(r => [r[0], r[1]]));
  const monthlyIncome = parseFloat(configMap.monthly_income || 8500);
  const savingsTarget = parseFloat(configMap.savings_target_pct || 21.5);

  // Balances
  const balanceObjs = rowsToObjects(balances);
  const balanceSummary = balanceObjs.map(b => ({
    account: b.Account,
    balance: parseFloat((b["Current Balance"] || b["Current Balanc"] || "0").replace(/[$,]/g, "")) || 0,
  }));

  // Current month spend — last 30 days from Spend account
  const now = new Date();
  const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);

  const allTxns = [...(spendRows.slice(1) || []), ...(billsRows.slice(1) || [])];
  const recentTxns = allTxns.filter(row => {
    if (!row[1]) return false;
    const txDate = new Date(row[1]);
    return txDate >= thirtyDaysAgo && row[5] === "debit";
  });

  // Aggregate by Redbark category
  const categorySpend = {};
  for (const row of recentTxns) {
    const category = row[6] || "UNCATEGORISED";
    if (["TRANSFER_OUT", "TRANSFER_IN", "INCOME"].includes(category)) continue;
    const amount = parseAmount(row[3], row[5]);
    categorySpend[category] = (categorySpend[category] || 0) + Math.abs(amount);
  }

  // Budget comparison
  const budgetObjs = rowsToObjects(budget);
  const budgetComparison = budgetObjs.map(b => {
    const rebarkCat = b.Redbark_Category;
    const spent = categorySpend[rebarkCat] || 0;
    const budgeted = parseFloat(b.Monthly_Budget) || 0;
    return {
      category: b.Category,
      spent: spent.toFixed(2),
      budget: budgeted.toFixed(2),
      variance: (spent - budgeted).toFixed(2),
      status: spent > budgeted ? "OVER" : "OK",
    };
  });

  const totalSpend = Object.values(categorySpend).reduce((a, b) => a + b, 0);
  const savingsRate = (((monthlyIncome - totalSpend) / monthlyIncome) * 100).toFixed(1);

  // Portfolio summary
  const priceObjs = rowsToObjects(prices);
  const portfolioTotal = priceObjs
    .filter(p => p.Current_Value && p.Current_Value !== "ERROR")
    .reduce((sum, p) => sum + parseFloat(p.Current_Value || 0), 0);
  const portfolioCost = priceObjs
    .reduce((sum, p) => sum + parseFloat(p.Cost_Basis || 0), 0);
  const portfolioPL = (portfolioTotal - portfolioCost).toFixed(2);

  const topMovers = priceObjs
    .filter(p => p.Change_24h_Pct && p.Change_24h_Pct !== "0")
    .sort((a, b) => Math.abs(parseFloat(b.Change_24h_Pct)) - Math.abs(parseFloat(a.Change_24h_Pct)))
    .slice(0, 3)
    .map(p => `${p.Ticker}: ${parseFloat(p.Change_24h_Pct) >= 0 ? "+" : ""}${p.Change_24h_Pct}%`);

  return {
    date: now.toLocaleDateString("en-AU", { timeZone: "Australia/Sydney", dateStyle: "full" }),
    balanceSummary,
    totalSpend: totalSpend.toFixed(2),
    monthlyIncome,
    savingsRate,
    savingsTarget,
    budgetComparison,
    categorySpend,
    portfolioTotal: portfolioTotal.toFixed(2),
    portfolioPL,
    portfolioPLPct: portfolioCost > 0 ? (((portfolioTotal - portfolioCost) / portfolioCost) * 100).toFixed(2) : "0",
    topMovers,
    holdingCount: priceObjs.length,
  };
}

// ── Claude summary ────────────────────────────────────────────────────────────
async function generateSummary(snapshot) {
  const overBudget = snapshot.budgetComparison.filter(b => b.status === "OVER");
  const underBudget = snapshot.budgetComparison.filter(b => b.status === "OK" && parseFloat(b.variance) < -50);

  const prompt = `You are a sharp, friendly personal finance assistant sending a morning briefing to Pramesh. Keep it punchy and conversational — no fluff, no disclaimers.

Today is ${snapshot.date}. Here is Pramesh's financial snapshot:

ACCOUNT BALANCES:
${snapshot.balanceSummary.map(b => `- ${b.account}: $${b.balance.toFixed(2)}`).join("\n")}

SPENDING (last 30 days):
- Total outgoings: $${snapshot.totalSpend}
- Monthly income: $${snapshot.monthlyIncome}
- Savings rate: ${snapshot.savingsRate}% (target: ${snapshot.savingsTarget}%)

BUDGET STATUS:
${snapshot.budgetComparison.map(b => `- ${b.category}: spent $${b.spent} vs $${b.budget} budget (${parseFloat(b.variance) >= 0 ? "+" : ""}$${b.variance})`).join("\n")}

INVESTMENT PORTFOLIO:
- Total value: $${snapshot.portfolioTotal} AUD across ${snapshot.holdingCount} holdings
- All-time P&L: ${parseFloat(snapshot.portfolioPL) >= 0 ? "+" : ""}$${snapshot.portfolioPL} (${parseFloat(snapshot.portfolioPLPct) >= 0 ? "+" : ""}${snapshot.portfolioPLPct}%)
- Today's top movers: ${snapshot.topMovers.join(", ") || "markets closed"}

Write a morning briefing in 4-6 sentences. Lead with the most important thing (good or bad). Call out any categories over budget by name. Give the savings rate a quick verdict. End with one sentence on the portfolio. Use plain AUD figures, no markdown formatting — this goes to Telegram.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) throw new Error(`Claude API error: ${res.status}`);
  const data = await res.json();
  return data.content[0].text;
}

// ── Telegram sender ────────────────────────────────────────────────────────────
async function sendTelegram(message) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: "HTML",
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Telegram error: ${res.status} — ${err}`);
  }
  console.log("✅ Telegram message sent");
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("🤖 Generating Claude summary:", new Date().toISOString());

  const snapshot = await gatherFinancialSnapshot();
  console.log(`📊 Snapshot ready — spend: $${snapshot.totalSpend}, portfolio: $${snapshot.portfolioTotal}`);

  const summary = await generateSummary(snapshot);
  console.log("📝 Claude summary generated:\n", summary);

  const aestTime = new Date().toLocaleString("en-AU", {
    timeZone: "Australia/Sydney",
    timeStyle: "short",
  });

  const message = `💰 <b>Morning Finance Briefing</b> · ${aestTime}\n\n${summary}\n\n<i>Dashboard → your-username.github.io/finance-dashboard</i>`;

  await sendTelegram(message);
  console.log("✅ Done:", new Date().toISOString());
}

main().catch(err => {
  console.error("💥 Fatal error:", err);
  process.exit(1);
});
