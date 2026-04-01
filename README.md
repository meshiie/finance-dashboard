# Finance Dashboard

Personal finance dashboard — automated daily updates, live portfolio tracking, and AI-generated briefings via Telegram.

## What it does

### Daily (10am AEDT)
- Fetches live ASX prices via Yahoo Finance
- Fetches SOL/AUD price via CoinGecko
- Reads all bank accounts synced via Redbark CDR
- Tracks discretionary spend vs fortnightly budget
- Generates Claude AI morning briefing → sends to Telegram
- Deploys updated dashboard to GitHub Pages

### Fortnightly (5pm AEDT, pay Wednesdays)
- Full cycle review vs previous fortnight
- Category spend comparison
- Actionable savings tips via Telegram

## Architecture

```
Banks (CDR Open Banking)
    ↓ Redbark
Google Sheets (source of truth)
    ↓ GitHub Actions (10am AEDT)
    ├── update-prices.js     → Yahoo Finance + CoinGecko → Prices tab
    ├── generate-data.js     → sanitised data.json for dashboard
    ├── claude-summary.js    → Claude API → Telegram
    └── index.html + data.json → GitHub Pages (PIN protected)
```

## Stack

- **Data sync:** Redbark → Google Sheets (Australian CDR open banking)
- **Automation:** GitHub Actions + Bun runtime
- **Prices:** Yahoo Finance (ASX) + CoinGecko (crypto) — both free
- **AI summaries:** Anthropic Claude API
- **Delivery:** Telegram bot
- **Dashboard:** GitHub Pages — static HTML, PIN protected

## Required GitHub Secrets

| Secret | Description |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Full JSON from Google Cloud service account |
| `SPREADSHEET_ID` | Google Sheet ID (from URL) |
| `ANTHROPIC_API_KEY` | Claude API key from console.anthropic.com |
| `TELEGRAM_BOT_TOKEN` | Token from @BotFather on Telegram |
| `TELEGRAM_CHAT_ID` | Your personal Telegram chat ID |
| `DASHBOARD_PIN` | PIN to access the dashboard (4-6 digits) |

## Google Sheet structure

| Tab | Source | Purpose |
|---|---|---|
| Balances | Redbark | Live balances for all accounts |
| HOLDINGS | Manual | Investment holdings — update on buy/sell |
| Budget | Manual | Monthly budget targets per category |
| Config | Manual | Global settings — income, payday, budgets |
| Prices | Script | Written by update-prices.js |

## Config tab keys

| Key | Purpose |
|---|---|
| `monthly_income` | Normal monthly salary |
| `fortnightly_income` | One fortnightly pay |
| `fortnightly_spend_budget` | Discretionary spend budget per fortnight |
| `fortnightly_savings_target` | Target savings amount per fortnight |
| `savings_target_pct` | Savings rate target % |
| `mortgage_amount` | Weekly mortgage repayment |
| `next_payday` | Next pay date (YYYY-MM-DD) |
| `pay_cycle_days` | Pay cycle length in days |
| `spend_sheet` | Sheet tab name for everyday spend |
| `bills_sheet` | Sheet tab name for bills |
| `offset_sheet` | Sheet tab name for main offset account |
| `savings_sheet` | Sheet tab name for savings account |

## Mortgage detection

Redbark does not categorise mortgage payments. The script detects them by matching `Withdrawal Direct Debit` in the transaction description and tracks them separately from other spend.

## Running manually

GitHub repo → Actions → Daily Finance Update → Run workflow

## Cron schedule

| Job | UTC cron | AEDT | Purpose |
|---|---|---|---|
| Daily | `0 0 * * *` | 10am daily | Morning briefing + dashboard update |
| Fortnightly | `0 7 * * 3` | 5pm Wednesdays | Fires payday review on pay Wednesdays |
