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

// ── Helpers ───────────────────────────────────────────────────────────────────
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

function parseTxns(rows) {
  return rows.slice(1).map(row => ({
    date: new Date(row[1]),
    desc: String(row[2]||""),
    amount: parseAmount(row[3]),
    direction: String(row[5]||"").toLowerCase(),
    cat: String(row[6]||"").trim(),
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
    out[tag] = (out[tag]||0) + t.amount;
  }
  return out;
}

function detectNewAdhocCharges(adhocBills, allTxns) {
  const now = new Date();
  const ydayStart = new Date(now); ydayStart.setUTCDate(ydayStart.getUTCDate()-1); ydayStart.setUTCHours(0,0,0,0);
  const ydayEnd = new Date(ydayStart.getTime()+86400000);
  const alerts = [];
  for (const bill of adhocBills) {
    const keyword = String(bill.match_keyword||"").toLowerCase();
    const newCharges = allTxns.filter(t =>
      t.direction==="debit" && t.date>=ydayStart && t.date<ydayEnd && t.desc.toLowerCase().includes(keyword)
    );
    if (newCharges.length === 0) continue;
    const cycleTotal = allTxns
      .filter(t => t.direction==="debit" && t.date>=bill.cycleStart && t.desc.toLowerCase().includes(keyword))
      .reduce((s,t)=>s+t.amount,0);
    for (const charge of newCharges) {
      alerts.push({ bill_name:bill.name, charge_amount:charge.amount, cycle_total:parseFloat(cycleTotal.toFixed(2)), budget:bill.amount, over:cycleTotal>bill.amount });
    }
  }
  return alerts;
}

// ── Telegram ──────────────────────────────────────────────────────────────────
async function sendTelegram(message) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({chat_id:TELEGRAM_CHAT_ID,text:message,parse_mode:"HTML"}),
  });
  if (!res.ok) throw new Error(`Telegram ${res.status}: ${await res.text()}`);
  console.log("✅ Telegram sent");
}

// ── Claude API ────────────────────────────────────────────────────────────────
async function askClaude(prompt, maxTokens=500) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method:"POST",
    headers:{"Content-Type":"application/json","x-api-key":ANTHROPIC_API_KEY,"anthropic-version":"2023-06-01"},
    body:JSON.stringify({model:"claude-sonnet-4-6",max_tokens:maxTokens,messages:[{role:"user",content:prompt}]}),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);
  return (await res.json()).content[0].text;
}

// ── Data gathering ────────────────────────────────────────────────────────────
async function gatherData() {
  // ── Freshness check — abort if Redbark hasn't synced in 24h ──────────────
  const freshness = await checkDataFreshness();
  if (!freshness.fresh) {
    const msg = `⚠️ <b>Redbark sync alert</b>\n\nYour bank data hasn't updated in <b>${freshness.ageHours} hours</b>.\nLast synced: ${freshness.lastSyncedStr}\n\nDashboard and briefings are running on stale data.\n\n👉 Check your <a href="https://app.redbark.co">Redbark dashboard</a> and reconnect if needed.`;
    await sendTelegram(msg);
    console.error(`❌ Stale data — aborting summary generation`);
    process.exit(0); // exit 0 — don't trigger GitHub failure email on top of Telegram alert
  }
  console.log(`✅ Data fresh — synced ${freshness.ageHours}h ago`);

  // Read Config
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
    .filter(r=>r[0]&&r[1])
    .map(r=>({account:String(r[0]),balance:parseAmount(r[1])}))
    .filter(b=>b.balance>0);

  const spend0524 = parseTxns(spend0524Raw);
  const bills6660 = parseTxns(bills6660Raw);
  const main1524 = parseTxns(main1524Raw);
  const allTxns = [...spend0524,...bills6660,...main1524];

  const discretionaryCats = buildCatTotals(spend0524, cycle.thisCycleStart);
  const discretionaryTotal = Object.values(discretionaryCats).reduce((a,b)=>a+b,0);
  const discretionaryRemaining = Math.max(0, fnSpendBudget-discretionaryTotal);
  const projectedDiscretionary = cycle.daysElapsed>0 ? (discretionaryTotal/cycle.daysElapsed)*cycle.cycleDays : 0;

  const prevDiscretionaryCats = buildCatTotals(spend0524, cycle.prevCycleStart, cycle.thisCycleStart);
  const prevDiscretionaryTotal = Object.values(prevDiscretionaryCats).reduce((a,b)=>a+b,0);

  const biggestThisCycle = spend0524
    .filter(t=>t.direction==="debit"&&t.date>=cycle.thisCycleStart&&isRealSpend(t.cat,t.desc))
    .sort((a,b)=>b.amount-a.amount)[0];

  const allCatsThisCycle = buildCatTotals(allTxns, cycle.thisCycleStart);
  const mortgageThisCycle = allCatsThisCycle["Mortgage"]||0;
  const totalSpendThisCycle = Object.values(allCatsThisCycle).reduce((a,b)=>a+b,0);

  const actualSavings = fnIncome - totalSpendThisCycle;
  const savingsRate = fnIncome>0 ? ((actualSavings/fnIncome)*100).toFixed(1) : "0";
  const onTrackSavings = actualSavings >= fnSavingsTarget;

  const budgetObjs = budgetRaw.slice(1).filter(r=>r[0]&&r[2]).map(r=>({
    category:String(r[0]).trim(), fnBudget:parseFloat(r[2])/2,
  }));
  const budgetComparison = budgetObjs
    .filter(b=>b.category!=="Mortgage"&&b.fnBudget>0)
    .map(b=>({category:b.category, spent:discretionaryCats[b.category]||0, budget:b.fnBudget, over:(discretionaryCats[b.category]||0)>b.fnBudget}));

  const ydayStart = new Date(now); ydayStart.setUTCDate(ydayStart.getUTCDate()-1); ydayStart.setUTCHours(0,0,0,0);
  const ydayEnd = new Date(ydayStart.getTime()+86400000);
  const yesterdayTxns = spend0524
    .filter(t=>t.direction==="debit"&&t.date>=ydayStart&&t.date<ydayEnd&&isRealSpend(t.cat,t.desc))
    .sort((a,b)=>b.amount-a.amount);

  const uncategorised = allTxns
    .filter(t=>t.direction==="debit"&&t.date>=cycle.thisCycleStart&&(t.cat===""||t.cat==="nan"||!t.cat)&&!isMortgage(t.desc)&&t.amount>1)
    .sort((a,b)=>b.amount-a.amount).slice(0,8);

  const billsSchedule = billsScheduleRaw.slice(1).filter(r=>r[0]).map(r=>({
    name:String(r[0]||"").trim(), amount:parseFloat(r[1])||0,
    frequency:String(r[2]||"").trim().toLowerCase(),
    match_keyword:String(r[5]||"").trim(),
    active:String(r[6]||"").trim().toUpperCase(),
    cycleStart:cycle.thisCycleStart,
  }));
  const adhocBills = billsSchedule.filter(b=>b.frequency==="adhoc"&&b.active==="YES");
  const newAdhocCharges = detectNewAdhocCharges(adhocBills, allTxns);

  const priceObjs = pricesRaw.slice(1).filter(r=>r[0]).map(r=>({
    Ticker:r[0], Change_24h_Pct:r[7], Current_Value:r[8], Cost_Basis:r[9],
  }));
  const portfolioTotal = priceObjs.filter(p=>p.Current_Value&&p.Current_Value!=="ERROR").reduce((s,p)=>s+parseFloat(p.Current_Value||0),0);
  const portfolioCost = priceObjs.reduce((s,p)=>s+parseFloat(p.Cost_Basis||0),0);
  const portfolioPL = portfolioTotal-portfolioCost;
  const portfolioPLPct = portfolioCost>0?((portfolioPL/portfolioCost)*100).toFixed(1):"0";
  const topMovers = priceObjs
    .filter(p=>p.Change_24h_Pct&&!["0","0.0","ERROR"].includes(String(p.Change_24h_Pct)))
    .sort((a,b)=>Math.abs(parseFloat(b.Change_24h_Pct))-Math.abs(parseFloat(a.Change_24h_Pct)))
    .slice(0,3).map(p=>`${p.Ticker}: ${parseFloat(p.Change_24h_Pct)>=0?"+":""}${parseFloat(p.Change_24h_Pct).toFixed(2)}%`);

  return {
    now, cycle, balances, cfg,
    discretionaryCats, discretionaryTotal, discretionaryRemaining, projectedDiscretionary,
    prevDiscretionaryCats, prevDiscretionaryTotal, biggestThisCycle,
    allCatsThisCycle, mortgageThisCycle, totalSpendThisCycle,
    fnIncome, fnSpendBudget, fnSavingsTarget, savingsTargetPct,
    actualSavings, savingsRate, onTrackSavings, budgetComparison,
    yesterdayTxns, uncategorised, newAdhocCharges,
    portfolioTotal, portfolioPL, portfolioPLPct, topMovers,
    isPayday: isPaydayToday(nextPayday, cycleDays),
  };
}

// ── Prompts ───────────────────────────────────────────────────────────────────
function buildDailyPrompt(d) {
  const pctUsed = d.fnSpendBudget>0?((d.discretionaryTotal/d.fnSpendBudget)*100).toFixed(0):"0";
  const projected = d.projectedDiscretionary>0?`$${d.projectedDiscretionary.toFixed(0)} projected at current pace`:"first day of cycle";
  const overBudget = d.budgetComparison.filter(b=>b.over).map(b=>`${b.category} ($${b.spent.toFixed(0)} vs $${b.budget.toFixed(0)} budget)`).join(", ")||"none — all on track";
  const topCats = Object.entries(d.allCatsThisCycle).filter(([c])=>c!=="Mortgage").sort(([,a],[,b])=>b-a).slice(0,4).map(([c,a])=>`${c}: $${a.toFixed(0)}`).join(", ");
  const bigTxn = d.biggestThisCycle?`Biggest this fortnight: $${d.biggestThisCycle.amount.toFixed(2)} — ${d.biggestThisCycle.desc.slice(0,50)}`:"No transactions yet this fortnight";
  const yday = d.yesterdayTxns.length>0?`Yesterday: ${d.yesterdayTxns.slice(0,3).map(t=>`$${t.amount.toFixed(2)} at ${t.desc.slice(0,35)}`).join(", ")}`:"No spend recorded yesterday";
  const balanceSummary = d.balances.map(b=>`$${b.balance.toLocaleString("en-AU",{minimumFractionDigits:2})}`).join(" | ");
  const uncatStr = d.uncategorised.length>0?`\nUNCATEGORISED (fix in Redbark):\n${d.uncategorised.map(t=>`  $${t.amount.toFixed(2)} — ${t.desc.slice(0,55)} (${t.date.toISOString().slice(0,10)})`).join("\n")}`:"\nNo uncategorised transactions ✅";

  return `You are Pramesh's direct personal finance assistant. Morning briefing — 5-6 sentences max, punchy, no fluff, no disclaimers.

FORTNIGHTLY CYCLE: Day ${d.cycle.daysElapsed+1} of ${d.cycle.cycleDays} — ${d.cycle.daysRemaining} days remaining

DISCRETIONARY SPEND (Spend account — budget $${d.fnSpendBudget}/fortnight):
  Spent: $${d.discretionaryTotal.toFixed(2)} (${pctUsed}% used) | Remaining: $${d.discretionaryRemaining.toFixed(2)} | ${projected}

${bigTxn}
${yday}

OVER BUDGET CATEGORIES: ${overBudget}
TOP CATEGORIES THIS CYCLE: ${topCats}
MORTGAGE THIS CYCLE: $${d.mortgageThisCycle.toFixed(2)}
TOTAL ALL ACCOUNTS: $${d.totalSpendThisCycle.toFixed(2)}

SAVINGS: $${d.actualSavings.toFixed(2)} vs $${d.fnSavingsTarget} target — ${d.onTrackSavings?"ON TRACK ✅":"BEHIND ⚠️"}
SAVINGS RATE: ${d.savingsRate}% vs ${d.savingsTargetPct}% target

BALANCES: ${balanceSummary}
PORTFOLIO: $${d.portfolioTotal.toLocaleString("en-AU",{minimumFractionDigits:2})} | P&L: ${d.portfolioPL>=0?"+":"-"}$${Math.abs(d.portfolioPL).toFixed(0)} (${d.portfolioPLPct}%) | ${d.topMovers.join(", ")||"markets closed"}
${uncatStr}

Write the briefing. Lead with discretionary spend (% used, days left, projected end). Mention biggest transaction, flag duplicates if spotted. Flag over-budget categories. Savings verdict. Portfolio one-liner. If uncategorised exist, note them briefly. Plain text only.`;
}

function buildFortnightlyPrompt(d) {
  const totalDiff = d.discretionaryTotal-d.prevDiscretionaryTotal;
  const catChanges = Object.keys({...d.discretionaryCats,...d.prevDiscretionaryCats})
    .map(cat=>{const curr=d.discretionaryCats[cat]||0,prev=d.prevDiscretionaryCats[cat]||0,diff=curr-prev;return `${cat}: $${curr.toFixed(0)} ${diff>20?"▲":diff<-20?"▼":"→"} (was $${prev.toFixed(0)}, ${diff>=0?"+":""}$${diff.toFixed(0)})`;}).join("\n");
  const bigTxn = d.biggestThisCycle?`$${d.biggestThisCycle.amount.toFixed(2)} at ${d.biggestThisCycle.desc.slice(0,55)}`:"no major transactions";
  const uncatStr = d.uncategorised.length>0?`\nUNCATEGORISED (fix in Redbark):\n${d.uncategorised.map(t=>`  $${t.amount.toFixed(2)} — ${t.desc.slice(0,55)} (${t.date.toISOString().slice(0,10)})`).join("\n")}` : "";

  return `You are Pramesh's personal finance coach. He just got paid — fortnightly summary. Direct, practical, 8-10 sentences, no disclaimers.

FORTNIGHT COMPLETED:
  Income: $${d.fnIncome.toLocaleString("en-AU",{minimumFractionDigits:2})}
  Total spend incl. mortgage ($${d.mortgageThisCycle.toFixed(0)}): $${d.totalSpendThisCycle.toFixed(2)}
  Discretionary (budget $${d.fnSpendBudget}): $${d.discretionaryTotal.toFixed(2)} (${totalDiff>=0?"+":""}$${totalDiff.toFixed(0)} vs last fortnight)
  Biggest transaction: ${bigTxn}
  Savings: $${d.actualSavings.toFixed(2)} vs $${d.fnSavingsTarget} target | Rate: ${d.savingsRate}%

CATEGORY BREAKDOWN this vs last fortnight:
${catChanges}
${uncatStr}

Write: pay acknowledgement + verdict. Biggest transaction call-out. 2-3 meaningful category changes. 2-3 specific tips for next fortnight. Plain text only.`;
}

function buildAdhocAlertMessage(charges, dateStr, timeStr) {
  const lines = charges.map(c=>{
    const budgetNote = c.over?`⚠️ Over $${c.budget} budget (total: $${c.cycle_total.toFixed(2)})`:`Running total: $${c.cycle_total.toFixed(2)} of $${c.budget} budget`;
    return `🚗 <b>${c.bill_name}</b>: $${c.charge_amount.toFixed(2)}\n${budgetNote}`;
  }).join("\n\n");
  return `⚡ <b>Adhoc charge detected</b> · ${dateStr} ${timeStr}\n\n${lines}`;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("🤖 Starting:", new Date().toISOString());
  const data = await gatherData();

  console.log(`📊 Day ${data.cycle.daysElapsed+1}/${data.cycle.cycleDays} | Discretionary: $${data.discretionaryTotal.toFixed(2)}/$${data.fnSpendBudget} | Savings: $${data.actualSavings.toFixed(2)}`);
  console.log(`🚗 New adhoc charges: ${data.newAdhocCharges.length} | 📅 Payday: ${data.isPayday}`);

  const timeStr = data.now.toLocaleTimeString("en-AU",{timeZone:"Australia/Sydney",hour:"2-digit",minute:"2-digit"});
  const dateStr = data.now.toLocaleDateString("en-AU",{timeZone:"Australia/Sydney",weekday:"short",day:"numeric",month:"short"});

  // Send adhoc alert first if any new charges detected
  if (data.newAdhocCharges.length > 0) {
    const alertMsg = buildAdhocAlertMessage(data.newAdhocCharges, dateStr, timeStr);
    await sendTelegram(alertMsg);
    console.log(`✅ Adhoc alert sent for ${data.newAdhocCharges.length} charge(s)`);
  }

  // Daily or fortnightly summary
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

  const dashboardUrl = `https://meshiie.github.io/finance-dashboard`;
  await sendTelegram(`${header} · ${dateStr} ${timeStr}\n\n${summary}\n\n📱 <a href="${dashboardUrl}">Open dashboard</a>`);
  console.log("✅ Done:", new Date().toISOString());
}

main().catch(err => { console.error("💥", err); process.exit(1); });
