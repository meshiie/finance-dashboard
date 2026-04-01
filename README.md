# Finance Dashboard

Personal finance dashboard for Pramesh Singh — automated daily updates, live portfolio tracking, and AI-generated briefings via Telegram.

---

## What it does

### Daily (10am AEDT, Mon–Sun)
- Reads all 4 bank accounts from Google Sheets (synced by Redbark)
- Fetches live ASX prices from Yahoo Finance
- Fetches SOL/AUD price from CoinGecko
- Writes updated prices + P&L to the Prices tab
- Generates a Claude AI morning briefing including:
  - Biggest transaction from yesterday
  - Category spend vs prior 7 days (L7D comparison)
  - Savings rate vs target
  - Portfolio one-liner + top movers
- Sends briefing to Telegram

### Fortnightly (5pm AEDT, every pay Wednesday)
- Detects payday automatically from Config tab (`next_payday` + `pay_cycle_days`)
- Analyses Spend account (0524) only — excludes mortgage and bills
- Generates a fortnightly pay summary including:
  - Biggest discretionary transaction
  - Category spend: this fortnight vs last fortnight
  - Specific actionable tips to improve savings rate
- Sends separate Telegram message at payday

---

## Architecture

```
Banks (AMP + Ubank)
    ↓ CDR (Consumer Data Right)
Fiskil / Redbark
    ↓ Auto-sync (webhook-triggered)
Google Sheets (source of truth)
    ↓ GitHub Actions (10am AEDT daily)
    ├── update-prices.js  → Yahoo Finance + CoinGecko → Prices tab
    └── claude-summary.js → Claude API → Telegram bot
```

---

## Google Sheet structure

| Tab name | Source | Purpose |
|---|---|---|
| `Pramesh Singh (1524)` | Redbark/AMP | Main offset — payroll, mortgage, major spend |
| `Pramesh Singh (4252)` | Redbark/AMP | Savings offset account |
| `Bills account (6660)` | Redbark/Ubank | Fixed bills account |
| `Spend account (0524)` | Redbark/Ubank | Everyday discretionary spend |
| `Balances` | Redbark | Live balances for all 4 accounts |
| `HOLDINGS` | Manual | Investment holdings — update when buying/selling |
| `Budget` | Manual | Monthly budget targets per category |
| `Config` | Manual | Global settings (income, payday, mortgage amount) |
| `Prices` | Script | Written by update-prices.js — do not edit manually |

---

## Config tab keys

| Key | Value | Notes |
|---|---|---|
| `monthly_income` | `9400` | Normal monthly income (2 fortnightly pays + rental) |
| `savings_target_pct` | `21.5` | Target savings rate % |
| `mortgage_amount` | `952.92` | Weekly mortgage payment amount |
| `next_payday` | `2026-04-08` | Next pay date — script auto-calculates future dates |
| `pay_cycle_days` | `14` | Fortnightly pay cycle |
| `spend_sheet` | `Spend account (0524)` | Sheet name for everyday spend |
| `bills_sheet` | `Bills account (6660)` | Sheet name for bills |
| `offset_sheet` | `Pramesh Singh (1524)` | Sheet name for main offset |
| `savings_sheet` | `Pramesh Singh (4252)` | Sheet name for savings offset |
| `balances_sheet` | `Balances` | Sheet name for balances |
| `holdings_sheet` | `HOLDINGS` | Sheet name for investment holdings |
| `prices_sheet` | `Prices` | Sheet name for live prices |

---

## Holdings tab

Update this manually when you buy or sell. The script reads it nightly.

| Column | Notes |
|---|---|
| `Ticker` | Yahoo Finance format: `NDQ.AX`, `AMP.AX`, `SOL` |
| `Name` | Display name |
| `Units` | Current units held |
| `Cost_Per_Unit` | Weighted average buy price in AUD |
| `Platform` | BetaShares Direct / Hellostake / Phantom |
| `Asset_Type` | `ETF`, `ASX`, or `CRYPTO` |

**Current holdings:** NDQ.AX, XMET.AX, IIND.AX (BetaShares Direct) · APX.AX, COH.AX, FDV.AX, IIND.AX, NDQ.AX, NIC.AX, PBH.AX, PLS.AX, RUL.AX, VLC.AX, SOL.AX, AMP.AX (Hellostake) · SOL (Phantom)

---

## Budget tab

12 spending categories mapped to Redbark's category system.

| Category | Redbark_Category | Monthly_Budget |
|---|---|---|
| Mortgage | MORTGAGE | 3900 |
| Groceries | FOOD_AND_DRINK | 500 |
| Eating out & cafes | FOOD_AND_DRINK | 600 |
| Transport | TRANSPORTATION | 400 |
| Health & medical | MEDICAL | 200 |
| Personal care & beauty | PERSONAL_CARE | 300 |
| Entertainment | ENTERTAINMENT | 150 |
| Shopping & clothing | MERCHANDISE | 200 |
| Utilities & bills | RENT_AND_UTILITIES | 250 |
| Insurance | LOAN_PAYMENTS | 200 |
| Home & garden | HOME_IMPROVEMENT | 150 |
| Govt & non-profit | GOVERNMENT_AND_NON_PROFIT | 50 |

Note: `FOOD_AND_DRINK` maps to two budget rows — split by merchant keywords (Woolworths/Coles/IGA etc = Groceries, everything else = Eating out).

---

## Repo structure

```
.github/
  workflows/
    daily-update.yml      ← cron: 10am AEDT daily + 5pm AEDT Wednesdays
scripts/
  update-prices.js        ← fetches live prices, writes to Prices tab
  claude-summary.js       ← builds snapshot, calls Claude, sends Telegram
  package.json
README.md
```

---

## Required GitHub Secrets

| Secret | Description |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Full JSON from Google Cloud service account |
| `SPREADSHEET_ID` | Google Sheet ID from the URL |
| `ANTHROPIC_API_KEY` | Claude API key from console.anthropic.com |
| `TELEGRAM_BOT_TOKEN` | Token from @BotFather |
| `TELEGRAM_CHAT_ID` | Your personal chat ID |

---

## Price sources

| Asset type | Source | Notes |
|---|---|---|
| ASX stocks + ETFs | Yahoo Finance (free) | Tickers must use `.AX` suffix |
| Crypto (SOL) | CoinGecko (free) | No API key needed for daily polling |

---

## Mortgage detection

Redbark does not have a MORTGAGE category. The script detects mortgage payments by matching `Withdrawal Direct Debit` in the description field of the 1524 account, and applies the `mortgage_amount` from Config to confirm. These are excluded from TRANSFER_OUT and counted as real spend.

---

## Triggering manually

Go to GitHub repo → Actions → Daily Finance Update → Run workflow → Run workflow

Useful for testing after config changes or re-running after a failure.

---

## Cron schedule

| Job | Cron | AEDT | Purpose |
|---|---|---|---|
| Daily | `0 0 * * *` | 10am every day | Morning briefing |
| Fortnightly check | `0 7 * * 3` | 5pm every Wednesday | Fires payday message on pay Wednesdays |

Cron runs in UTC. AEDT = UTC+10 (after daylight saving ends Apr 6 2026).
