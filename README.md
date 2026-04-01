# finance-dashboard

Personal finance dashboard — automated daily updates via GitHub Actions.

## What it does

- Runs every night at 1am AEST
- Fetches live ASX prices from Yahoo Finance
- Fetches SOL/AUD price from CoinGecko
- Writes all prices + P&L to Google Sheets
- Generates a Claude AI morning summary
- Sends summary to Telegram

## Repo structure

```
.github/workflows/daily-update.yml   ← cron job
scripts/
  update-prices.js                   ← fetches prices, writes to Sheets
  claude-summary.js                  ← generates AI summary, sends Telegram
  package.json
```

## Required GitHub Secrets

| Secret | Description |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Full JSON key from Google Cloud |
| `SPREADSHEET_ID` | Google Sheet ID |
| `ANTHROPIC_API_KEY` | Claude API key |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token |
| `TELEGRAM_CHAT_ID` | Your Telegram chat ID |

## Manual trigger

Go to Actions tab → Daily Finance Update → Run workflow
