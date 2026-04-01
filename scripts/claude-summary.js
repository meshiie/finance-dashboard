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
  return rows.slice(1).map((row) =>
    Object.fromEntries(headers.map((h, i) => [h, row[i] ?? ""]))
  );
}

function parseAmount(val) {
  if (!val) return 0;
  const s = String(val).replace(/[$,\s()]/g, "");
  return Math.abs(parseFloat(s) || 0);
}

function isMortgageRow(desc, category, mortgageAmt) {
  const d = (desc || "").toLowerCase();
  const amt = parseAmount(desc.match(/\d[\d.,]*/)?.[0]);
  return (
    d.includes("withdrawal direct debit") ||
    (d.includes("direct debit") && Math.abs(amt - mortgageAmt) < 1)
  );
}

// Grocery keyword split from FOOD_AND_DRINK
const GROCERY_MERCHANTS = [
  "woolworths", "coles", "aldi", "iga", "harris farm", "costco",
  "foodworks", "spar", "drakes", "supabarn", "ritchies",
  "bulk nutrients", "chemist warehouse", "priceline",
];

function isGrocery(desc) {
  const d = (desc || "").toLowerCase();
  return GROCERY_MERCHANTS.some((m) => d.includes(m));
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function isPayday(nextPaydayStr, cycleDays) {
  const today = new Date();
  const todayAEST = new Date(
    today.toLocaleString("en-AU", { timeZone: "Australia/Sydney" })
  );
  const nextPayday = new Date(nextPaydayStr);
  const diffDays = Math.round(
    (todayAEST - nextPayday) / (1000 * 60 * 60 * 24)
  );
  // It's a payday if today is on or after nextPayday and within the cycle
  return diffDays >= 0 && diffDays % cycleDays === 0;
}

function getFortnightBounds(nextPaydayStr, cycleDays) {
  const nextPayday = new Date(nextPaydayStr);
  const today = new Date();
  const diffDays = Math.round((today - nextPayday) / (1000 * 60 * 60 * 24));
  const cyclesSince = Math.floor(diffDays / cycleDays);

  const thisCycleStart = new Date(nextPayday);
  thisCycleStart.setDate(thisCycleStart.getDate() + cyclesSince * cycleDays);

  const prevCycleStart = new Date(thisCycleStart);
  prevCycleStart.setDate(prevCycleStart.getDate() - cycleDays);

  return { thisCycleStart, prevCycleStart };
}

// ── Data gathering ────────────────────────────────────────────────────────────

async function gatherData() {
  const nowAEST = new Date(
    new Date().toLocaleString("en-AU", { timeZone: "Australia/Sydney" })
  );
  const cutoff30d = new Date(nowAEST);
  cutoff30d.setDate(cutoff30d.getDate() - 30);
  const cutoff7d = new Date(nowAEST);
  cutoff7d.setDate(cutoff7d.getDate() - 7);
  const cutoff14d = new Date(nowAEST);
  cutoff14d.setDate(cutoff14d.getDate() - 14);
  const yesterday = new Date(nowAEST);
  yesterday.setDate(yesterday.getDate() - 1);

  const [balances, prices, config, budget,
    spend0524, bills6660, main1524] = await Promise.all([
    readSheet("Balances!A:E"),
    readSheet("Prices!A:M"),
    readSheet("Config!A:B"),
    readSheet("Budget!A:C"),
    readSheet("Spend account (0524)!A:L"),
    readSheet("Bills account (6660)!A:L"),
    readSheet("Pramesh Singh (1524)!A:L"),
  ]);

  // Config map
  const cfg = Object.fromEntries(
    (config.slice(1) || []).filter((r) => r[0]).map((r) => [r[0], r[1]])
  );
  const monthlyIncome = parseFloat(cfg.monthly_income || 9400);
  const savingsTarget = parseFloat(cfg.savings_target_pct || 21.5);
  const mortgageAmt = parseFloat(cfg.mortgage_amount || 952.92);
  const nextPayday = cfg.next_payday || "2026-04-08";
  const cycleDays = parseInt(cfg.pay_cycle_days || 14);

  // Balances
  const balanceObjs = rowsToObjects(balances);

  // Parse all transactions across all relevant sheets
  function parseTxns(rows) {
    return rows.slice(1).map((row) => ({
      date: new Date(row[1]),
      desc: String(row[2] || ""),
      amount: parseAmount(row[3]),
      direction: String(row[5] || "").toLowerCase(),
      category: String(row[6] || "").trim(),
      account: String(row[8] || ""),
    })).filter((t) => !isNaN(t.date) && t.direction === "debit");
  }

  const allSpend = [
    ...parseTxns(spend0524),
    ...parseTxns(bills6660),
    ...parseTxns(main1524),
  ];

  // Tag categories properly
  function tagTxn(t) {
    if (isMortgageRow(t.desc, t.category, mortgageAmt)) return "Mortgage";
    if (t.category === "FOOD_AND_DRINK") {
      return isGrocery(t.desc) ? "Groceries" : "Eating out & cafes";
    }
    const catMap = {
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
    return catMap[t.category] || null;
  }

  // Filter helpers
  const skipCategories = new Set(["TRANSFER_OUT", "TRANSFER_IN", "INCOME", ""]);
  function isRealSpend(t) {
    if (skipCategories.has(t.category)) {
      // Still include mortgage even though it's tagged TRANSFER_OUT
      return isMortgageRow(t.desc, t.category, mortgageAmt);
    }
    return true;
  }

  // ── Last 30 days total spend ──────────────────────────────────────────────
  const spend30d = allSpend.filter(
    (t) => t.date >= cutoff30d && isRealSpend(t)
  );

  // Category totals last 30d
  const cat30d = {};
  for (const t of spend30d) {
    const tag = tagTxn(t);
    if (!tag) continue;
    cat30d[tag] = (cat30d[tag] || 0) + t.amount;
  }
  const total30d = Object.values(cat30d).reduce((a, b) => a + b, 0);

  // ── Last 7 days spend ─────────────────────────────────────────────────────
  const spend7d = allSpend.filter(
    (t) => t.date >= cutoff7d && isRealSpend(t)
  );
  const cat7d = {};
  for (const t of spend7d) {
    const tag = tagTxn(t);
    if (!tag) continue;
    cat7d[tag] = (cat7d[tag] || 0) + t.amount;
  }

  // ── Previous 7 days (L7D comparison) ─────────────────────────────────────
  const spend7d_prev = allSpend.filter(
    (t) => t.date >= cutoff14d && t.date < cutoff7d && isRealSpend(t)
  );
  const cat7d_prev = {};
  for (const t of spend7d_prev) {
    const tag = tagTxn(t);
    if (!tag) continue;
    cat7d_prev[tag] = (cat7d_prev[tag] || 0) + t.amount;
  }

  // ── Yesterday's transactions ──────────────────────────────────────────────
  const spendYesterday = allSpend.filter((t) => {
    return (
      t.date.toDateString() === yesterday.toDateString() && isRealSpend(t)
    );
  });
  const biggestYesterday = spendYesterday
    .filter((t) => tagTxn(t) && tagTxn(t) !== "Mortgage")
    .sort((a, b) => b.amount - a.amount)[0];

  // ── Income last 30d (from 1524 only — that's where payroll lands) ─────────
  const income30d = main1524.slice(1)
    .map((row) => ({
      date: new Date(row[1]),
      amount: parseAmount(row[3]),
      direction: String(row[5] || "").toLowerCase(),
      category: String(row[6] || "").trim(),
      desc: String(row[2] || ""),
    }))
    .filter(
      (t) =>
        t.direction === "credit" &&
        t.category === "INCOME" &&
        t.date >= cutoff30d
    );
  const totalIncome30d = income30d.reduce((s, t) => s + t.amount, 0);

  // Use monthly income config as denominator (normalised, not bonus-inflated)
  const savingsRate = (
    ((monthlyIncome - (total30d / 30) * 30) / monthlyIncome) * 100
  ).toFixed(1);

  // ── Budget comparison ─────────────────────────────────────────────────────
  const budgetObjs = rowsToObjects(budget);
  const budgetComparison = budgetObjs
    .filter((b) => b.Category)
    .map((b) => {
      const spent = cat30d[b.Category] || 0;
      const budgeted = parseFloat(b.Monthly_Budget) || 0;
      return {
        category: b.Category,
        spent: spent.toFixed(2),
        budget: budgeted.toFixed(2),
        variance: (spent - budgeted).toFixed(2),
        over: spent > budgeted,
      };
    });

  // ── Fortnightly spend data (Spend 0524 only, no mortgage/bills) ───────────
  const { thisCycleStart, prevCycleStart } = getFortnightBounds(
    nextPayday,
    cycleDays
  );

  function parseSpend0524(rows) {
    return rows.slice(1).map((row) => ({
      date: new Date(row[1]),
      desc: String(row[2] || ""),
      amount: parseAmount(row[3]),
      direction: String(row[5] || "").toLowerCase(),
      category: String(row[6] || "").trim(),
    })).filter(
      (t) =>
        t.direction === "debit" &&
        !skipCategories.has(t.category)
    );
  }

  const spendAcctTxns = parseSpend0524(spend0524);

  const thisFortnight = spendAcctTxns.filter(
    (t) => t.date >= thisCycleStart
  );
  const prevFortnight = spendAcctTxns.filter(
    (t) => t.date >= prevCycleStart && t.date < thisCycleStart
  );

  function catTotals(txns) {
    const out = {};
    for (const t of txns) {
      const tag = tagTxn(t);
      if (!tag || tag === "Mortgage") continue;
      out[tag] = (out[tag] || 0) + t.amount;
    }
    return out;
  }

  const thisFortnightCats = catTotals(thisFortnight);
  const prevFortnightCats = catTotals(prevFortnight);

  const biggestDiscretionary = thisFortnight
    .filter((t) => tagTxn(t) && tagTxn(t) !== "Mortgage")
    .sort((a, b) => b.amount - a.amount)[0];

  const thisFortnightTotal = Object.values(thisFortnightCats).reduce(
    (a, b) => a + b,
    0
  );
  const prevFortnightTotal = Object.values(prevFortnightCats).reduce(
    (a, b) => a + b,
    0
  );

  // ── Portfolio ─────────────────────────────────────────────────────────────
  const priceObjs = rowsToObjects(prices);
  const portfolioTotal = priceObjs
    .filter((p) => p.Current_Value && p.Current_Value !== "ERROR" && p.Current_Value !== "0")
    .reduce((s, p) => s + parseFloat(p.Current_Value || 0), 0);
  const portfolioCost = priceObjs.reduce(
    (s, p) => s + parseFloat(p.Cost_Basis || 0),
    0
  );
  const portfolioPL = (portfolioTotal - portfolioCost).toFixed(2);
  const portfolioPLPct =
    portfolioCost > 0
      ? (((portfolioTotal - portfolioCost) / portfolioCost) * 100).toFixed(2)
      : "0";

  const topMovers = priceObjs
    .filter(
      (p) =>
        p.Change_24h_Pct &&
        p.Change_24h_Pct !== "0" &&
        p.Change_24h_Pct !== "ERROR"
    )
    .sort(
      (a, b) =>
        Math.abs(parseFloat(b.Change_24h_Pct)) -
        Math.abs(parseFloat(a.Change_24h_Pct))
    )
    .slice(0, 3)
    .map(
      (p) =>
        `${p.Ticker}: ${parseFloat(p.Change_24h_Pct) >= 0 ? "+" : ""}${p.Change_24h_Pct}%`
    );

  return {
    nowAEST,
    balanceObjs,
    cat30d,
    cat7d,
    cat7d_prev,
    total30d,
    totalIncome30d,
    monthlyIncome,
    savingsRate,
    savingsTarget,
    budgetComparison,
    biggestYesterday,
    portfolioTotal: portfolioTotal.toFixed(2),
    portfolioPL,
    portfolioPLPct,
    topMovers,
    isPayday: isPayday(nextPayday, cycleDays),
    thisFortnightCats,
    prevFortnightCats,
    thisFortnightTotal: thisFortnightTotal.toFixed(2),
    prevFortnightTotal: prevFortnightTotal.toFixed(2),
    biggestDiscretionary,
  };
}

// ── Claude API call ───────────────────────────────────────────────────────────

async function askClaude(prompt, maxTokens = 450) {
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
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API ${res.status}: ${err}`);
  }
  const data = await res.json();
  return data.content[0].text;
}

// ── Telegram ──────────────────────────────────────────────────────────────────

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
  if (!res.ok) throw new Error(`Telegram ${res.status}: ${await res.text()}`);
  console.log("✅ Telegram sent");
}

// ── Daily briefing prompt ─────────────────────────────────────────────────────

function buildDailyPrompt(d) {
  const overBudget = d.budgetComparison
    .filter((b) => b.over)
    .map((b) => `${b.category} ($${b.spent} vs $${b.budget} budget, +$${b.variance} over)`)
    .join(", ");

  const l7dComparison = Object.entries(d.cat7d)
    .map(([cat, amt]) => {
      const prev = d.cat7d_prev[cat] || 0;
      const diff = amt - prev;
      const arrow = diff > 0 ? "▲" : diff < 0 ? "▼" : "→";
      return `${cat}: $${amt.toFixed(0)} ${arrow} ${diff >= 0 ? "+" : ""}$${diff.toFixed(0)} vs prior 7d`;
    })
    .join("\n");

  const bigTxn = d.biggestYesterday
    ? `Biggest transaction yesterday: $${d.biggestYesterday.amount.toFixed(2)} at ${d.biggestYesterday.desc.slice(0, 40)} (${d.biggestYesterday.category})`
    : "No significant transactions yesterday";

  const balanceSummary = d.balanceObjs
    .filter((b) => b["Current Balance"] && !isNaN(parseFloat(b["Current Balance"])))
    .map((b) => `${b.Account}: $${parseFloat(b["Current Balance"]).toLocaleString("en-AU", { minimumFractionDigits: 2 })}`)
    .join(", ");

  return `You are a sharp, direct personal finance assistant sending Pramesh his morning briefing. Keep it punchy — 5-6 sentences max. No fluff, no disclaimers, no financial advice disclaimers.

DATE: ${d.nowAEST.toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long" })}

ACCOUNT BALANCES: ${balanceSummary}

${bigTxn}

SPENDING LAST 7 DAYS vs PRIOR 7 DAYS:
${l7dComparison}

MONTHLY SAVINGS RATE: ${d.savingsRate}% (target: ${d.savingsTarget}%)
TOTAL SPEND (30d): $${d.total30d.toFixed(2)}
OVER BUDGET CATEGORIES: ${overBudget || "none — all on track"}

PORTFOLIO: $${d.portfolioTotal} AUD | All-time P&L: ${parseFloat(d.portfolioPL) >= 0 ? "+" : ""}$${d.portfolioPL} (${d.portfolioPLPct}%)
TOP MOVERS TODAY: ${d.topMovers.join(", ") || "markets closed"}

Write the briefing. Lead with the most important thing. Call out the biggest transaction. Flag any over-budget categories by name. End with one sentence on the portfolio. No markdown, plain text only — this goes straight to Telegram.`;
}

// ── Fortnightly prompt ────────────────────────────────────────────────────────

function buildFortnightlyPrompt(d) {
  const catChanges = Object.keys({
    ...d.thisFortnightCats,
    ...d.prevFortnightCats,
  })
    .map((cat) => {
      const curr = d.thisFortnightCats[cat] || 0;
      const prev = d.prevFortnightCats[cat] || 0;
      const diff = curr - prev;
      const arrow = diff > 10 ? "▲" : diff < -10 ? "▼" : "→";
      return `${cat}: $${curr.toFixed(0)} ${arrow} (was $${prev.toFixed(0)}, ${diff >= 0 ? "+" : ""}$${diff.toFixed(0)})`;
    })
    .join("\n");

  const bigTxn = d.biggestDiscretionary
    ? `$${d.biggestDiscretionary.amount.toFixed(2)} at ${d.biggestDiscretionary.desc.slice(0, 50)}`
    : "no large transactions";

  return `You are Pramesh's personal finance coach. He just got paid. Write a fortnightly pay summary — direct, practical, no waffle. 8-10 sentences.

FORTNIGHT OVERVIEW:
- This fortnight discretionary spend (Spend account only, excl. mortgage/bills): $${d.thisFortnightTotal}
- Last fortnight spend: $${d.prevFortnightTotal}
- Change: ${(parseFloat(d.thisFortnightTotal) - parseFloat(d.prevFortnightTotal)).toFixed(2) >= 0 ? "+" : ""}$${(parseFloat(d.thisFortnightTotal) - parseFloat(d.prevFortnightTotal)).toFixed(2)}

BIGGEST DISCRETIONARY TRANSACTION THIS FORTNIGHT: ${bigTxn}

CATEGORY BREAKDOWN (this fortnight vs last):
${catChanges}

SAVINGS RATE (monthly basis): ${d.savingsRate}% vs ${d.savingsTarget}% target

Write the summary. Start with payday acknowledgement. Call out the biggest transaction. Walk through 2-3 notable category shifts (up or down). Give 2-3 specific, actionable tips for the next fortnight to push the savings rate higher. Be encouraging but honest. Plain text only — no markdown, no disclaimers.`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("🤖 Starting summary generation:", new Date().toISOString());

  const data = await gatherData();
  console.log(`📊 Data ready — spend 30d: $${data.total30d.toFixed(2)}, portfolio: $${data.portfolioTotal}`);
  console.log(`📅 Is payday: ${data.isPayday}`);

  const timeAEST = data.nowAEST.toLocaleTimeString("en-AU", {
    hour: "2-digit",
    minute: "2-digit",
  });
  const dateAEST = data.nowAEST.toLocaleDateString("en-AU", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });

  if (data.isPayday) {
    // Fortnightly payday summary
    console.log("💰 Generating fortnightly payday summary...");
    const summary = await askClaude(buildFortnightlyPrompt(data), 600);
    const msg = `💰 <b>Payday Fortnight Review</b> · ${dateAEST} ${timeAEST}\n\n${summary}`;
    await sendTelegram(msg);
  } else {
    // Daily briefing
    console.log("📋 Generating daily briefing...");
    const summary = await askClaude(buildDailyPrompt(data), 450);
    const msg = `📊 <b>Morning Briefing</b> · ${dateAEST} ${timeAEST}\n\n${summary}`;
    await sendTelegram(msg);
  }

  console.log("✅ Done:", new Date().toISOString());
}

main().catch((err) => {
  console.error("💥 Fatal:", err);
  process.exit(1);
});
