# Finance Dashboard

Personal finance dashboard — automated daily updates, live portfolio tracking, AI-generated briefings via Telegram, and a PIN-protected web dashboard.

## What it does

### Daily (10am AEST, every day)
- Checks Redbark data freshness — if bank data is stale (>24h), fires a Telegram alert and aborts
- Fetches live ASX prices via Yahoo Finance
- Fetches SOL/AUD price via CoinGecko
- Reads all 4 bank accounts synced via Redbark CDR
- Tracks discretionary spend vs fortnightly budget (Spend account only)
- Detects adhoc charges (Tolls, Public Transport) and alerts via Telegram if a new charge appeared yesterday
- Generates a Claude AI morning briefing → sends to Telegram
- Writes sanitised `data.json` → deploys to GitHub Pages

### Fortnightly (5pm AEST, pay Wednesdays)
- Detects payday automatically from Config tab
- Generates full cycle review vs previous fortnight → sends to Telegram
- Category spend comparison + actionable savings tips

### Telegram message types
| Message | Trigger | Content |
|---|---|---|
| 📊 Morning Briefing | Daily 10am | Discretionary spend, savings rate, biggest transaction, portfolio, uncategorised |
| 💸 Payday Review | Pay Wednesdays 5pm | Full cycle review, category changes, tips for next fortnight |
| ⚡ Adhoc charge | When LINKT/TRANSPORTFORNSW detected | Charge amount + running total vs budget cap |
| ⚠️ Redbark alert | When data >24h stale | Last sync time + link to Redbark dashboard |

---

## Architecture

```
Banks (AMP + Ubank — CDR Open Banking)
    ↓ Redbark (webhook-triggered sync)
Google Sheets (source of truth)
    ↓ GitHub Actions (10am AEST daily)
    ├── update-prices.js    → Yahoo Finance + CoinGecko → Prices tab
    ├── generate-data.js    → sanitised data.json (no PII)
    └── claude-summary.js   → Claude API → Telegram
    ↓
GitHub Pages → index.html + data.json (PIN protected)
```

### Two-job workflow structure
- **Job 1 (update):** Runs immediately on schedule — no environment gate. Handles all data fetching, Telegram delivery, and builds the site artifact.
- **Job 2 (deploy):** Runs after Job 1. Deploys artifact to GitHub Pages via the `github-pages` environment. Gated separately so Pages delays never block Telegram.

---

## Google Sheet structure

| Tab | Source | Purpose |
|---|---|---|
| Balances | Redbark | Live balances + Last Updated timestamp (used for freshness check) |
| HOLDINGS | Manual | Investment holdings — update on buy/sell |
| Budget | Manual | Monthly budget targets per category |
| Config | Manual | Global settings — income, payday, budgets |
| Bills Schedule | Manual | Fixed + adhoc bill definitions |
| Prices | Script | Written by update-prices.js — do not edit manually |

---

## Config tab keys

| Key | Example | Purpose |
|---|---|---|
| `monthly_income` | `8431` | Normal monthly salary |
| `fortnightly_income` | `4215` | One fortnightly pay |
| `fortnightly_spend_budget` | `1000` | Discretionary spend budget per fortnight (Spend account) |
| `fortnightly_savings_target` | `600` | Target savings amount per fortnight |
| `savings_target_pct` | `14.2` | Savings rate target % |
| `mortgage_amount` | `952.92` | Weekly mortgage repayment amount |
| `next_payday` | `2026-04-08` | Next pay date (YYYY-MM-DD) — script auto-calculates future dates |
| `pay_cycle_days` | `14` | Pay cycle length in days |
| `rental_income_end_date` | `2026-04-15` | Date rental income stops |
| `spend_sheet` | `Spend account (0524)` | Sheet tab name for everyday spend |
| `bills_sheet` | `Bills account (6660)` | Sheet tab name for bills |
| `offset_sheet` | `Pramesh Singh (1524)` | Sheet tab name for main offset |
| `savings_sheet` | `Pramesh Singh (4252)` | Sheet tab name for savings offset |
| `balances_sheet` | `Balances` | Sheet tab name for balances |
| `holdings_sheet` | `HOLDINGS` | Sheet tab name for investment holdings |
| `prices_sheet` | `Prices` | Sheet tab name for live prices |

---

## Bills Schedule tab

Columns: `Name | Amount | Frequency | Due_Day | Account | Match_Keyword | Active`

| Frequency | Due_Day | Amount meaning | Behaviour |
|---|---|---|---|
| `weekly` | Day name (e.g. Monday) | Fixed charge amount | Appears on every matching weekday in the 14-day window |
| `monthly` | Day number (1–28) | Fixed charge amount | Appears on that calendar day if it falls in the current cycle |
| `adhoc` | *(leave blank)* | Fortnightly budget cap | Scans all transactions for keyword match — no due date |

**Paid detection:** Script searches transactions ±4 days of due date for `Match_Keyword`. For bills sharing the same keyword (e.g. Ladder App and Runna both use `APPLE.COM/BILL`), amount proximity within $2 is used to distinguish them.

**Adhoc bills** (Tolls, Public Transport) show in the dashboard with a running total vs budget cap, and on the calendar on actual charge dates. A Telegram alert fires when a new charge is detected.

---

## Holdings tab

Update manually when buying or selling. Script reads it nightly.

| Column | Notes |
|---|---|
| `Ticker` | Yahoo Finance format for ASX: `NDQ.AX`, `AMP.AX` etc. Crypto: `SOL` |
| `Name` | Display name |
| `Units` | Current units held |
| `Cost_Per_Unit` | Weighted average buy price in AUD |
| `Platform` | BetaShares Direct / Stake / Hellostake / Phantom |
| `Asset_Type` | `ETF`, `Stock`, or `CRYPTO` |

**Price sources:** `CRYPTO` → CoinGecko. Everything else → Yahoo Finance (`.AX` suffix required for ASX tickers).

---

## Budget tab

Monthly budget targets. Script divides by 2 for fortnightly comparisons.

Columns: `Category | Redbark_Category | Monthly_Budget`

**FOOD_AND_DRINK split:** Transactions tagged `FOOD_AND_DRINK` by Redbark are split by merchant keyword — Woolworths, Coles, Aldi, IGA etc → Groceries. Everything else → Eating out & cafes.

**Mortgage detection:** Redbark has no MORTGAGE category. Script detects mortgage payments by matching `Withdrawal Direct Debit` in the transaction description and tracks them separately.

---

## Dashboard

PIN-protected static HTML at `https://meshiie.github.io/finance-dashboard`

- **PIN required every visit** — no localStorage, no bypass. Enter PIN → data loads. Close tab → PIN required again.
- **Auto-refreshes** every 30 minutes while tab is open
- **Sections:** Fortnightly spend bar, savings stats, portfolio value, category spend bars, fixed bills progress + 14-day calendar, adhoc tracking (Tolls/Transport), portfolio holdings table, account balances

**Calendar colour coding:**
- 🟢 Green = paid
- 🔵 Blue = upcoming
- 🟡 Amber = adhoc charge occurred
- 🔴 Red = overdue

---

## Repo structure

```
.github/
  workflows/
    daily-update.yml      ← two-job: update (no gate) + deploy (pages env)
scripts/
  update-prices.js        ← fetches prices → writes to Prices tab
  generate-data.js        ← builds data.json + freshness check + adhoc detection
  claude-summary.js       ← reads sheets + calls Claude + sends Telegram
  package.json
index.html                ← dashboard (PIN every visit, reads data.json)
README.md
```

---

## Required GitHub Secrets

| Secret | Description |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Full JSON from Google Cloud service account |
| `SPREADSHEET_ID` | Google Sheet ID (from URL) |
| `ANTHROPIC_API_KEY` | Claude API key from console.anthropic.com |
| `TELEGRAM_BOT_TOKEN` | Token from @BotFather on Telegram |
| `TELEGRAM_CHAT_ID` | Your personal Telegram chat ID |
| `DASHBOARD_PIN` | PIN to access the dashboard (4–6 digits) |

---

## Cron schedule

| Job | UTC cron | AEST | Purpose |
|---|---|---|---|
| Daily | `0 0 * * *` | 10am every day | Morning briefing + dashboard update |
| Fortnightly check | `0 7 * * 3` | 5pm every Wednesday | Fires payday review on pay Wednesdays only |

Cron runs in UTC. AEST = UTC+10 (daylight saving ended 6 April 2026).

---

## Error handling & monitoring

| Failure | Detection | Response |
|---|---|---|
| Redbark stops syncing | Freshness check on Balances tab Last Updated column | Telegram alert + clean exit (no GitHub failure email) |
| GitHub Actions step fails | GitHub built-in email notification | Email to GitHub account |
| Yahoo Finance API fails | Caught per-ticker, writes ERROR to Prices tab | Holdings show $0 on dashboard |
| Claude API fails | Unhandled exception | GitHub failure email |
| Telegram fails | Unhandled exception | GitHub failure email |

**GitHub notification setup:** `github.com/settings/notifications` → Actions → enable failed workflow emails.

---

## Running manually

GitHub repo → Actions → Daily Finance Update → Run workflow → Run workflow

Use for: testing after config changes, re-running after a failure, or getting your briefing if the scheduler hasn't fired yet.
