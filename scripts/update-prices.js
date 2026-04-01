import { google } from "googleapis";

// ── Auth ────────────────────────────────────────────────────────────────────
const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

// ── Helpers ──────────────────────────────────────────────────────────────────
async function readSheet(range) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range,
  });
  return res.data.values || [];
}

async function writeSheet(range, values) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range,
    valueInputOption: "USER_ENTERED",
    requestBody: { values },
  });
}

// ── Price fetchers ───────────────────────────────────────────────────────────

// Yahoo Finance — works for ASX (NDQ.AX), ETFs, all ASX tickers
async function fetchYahooPrice(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=2d`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!res.ok) throw new Error(`Yahoo fetch failed for ${ticker}: ${res.status}`);
  const data = await res.json();
  const meta = data.chart.result[0].meta;
  const price = meta.regularMarketPrice;
  const prev = meta.chartPreviousClose;
  const change24h = prev ? (((price - prev) / prev) * 100).toFixed(2) : "0.00";
  return { price: price.toFixed(4), change24h };
}

// CoinGecko — free, no API key needed for basic usage
async function fetchCoinGeckoPrice(coinId) {
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=aud&include_24hr_change=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CoinGecko fetch failed for ${coinId}: ${res.status}`);
  const data = await res.json();
  const price = data[coinId].aud;
  const change24h = data[coinId].aud_24h_change?.toFixed(2) ?? "0.00";
  return { price: price.toFixed(4), change24h };
}

// Maps ticker → fetch function + identifier
function getFecher(ticker, assetType) {
  if (assetType === "CRYPTO") {
    const coinMap = { SOL: "solana", BTC: "bitcoin", ETH: "ethereum" };
    const coinId = coinMap[ticker.toUpperCase()];
    if (!coinId) throw new Error(`Unknown crypto: ${ticker}`);
    return () => fetchCoinGeckoPrice(coinId);
  }
  // ASX stocks and ETFs — Yahoo Finance uses .AX suffix
  const yahooTicker = ticker.includes(".") ? ticker : `${ticker}.AX`;
  return () => fetchYahooPrice(yahooTicker);
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("📊 Starting price update:", new Date().toISOString());

  // Read Holdings tab — skip header row
  const holdings = await readSheet("Holdings!A:F");
  const rows = holdings.slice(1).filter(r => r[0]); // skip header, skip empty rows

  const timestamp = new Date().toLocaleString("en-AU", {
    timeZone: "Australia/Sydney",
    dateStyle: "short",
    timeStyle: "short",
  });

  const priceRows = [["Ticker", "Name", "Units", "Cost_Per_Unit", "Platform", "Asset_Type", "Price_AUD", "Change_24h_Pct", "Current_Value", "Cost_Basis", "PL_AUD", "PL_Pct", "Last_Updated"]];

  for (const row of rows) {
    const [ticker, name, units, costPerUnit, platform, assetType] = row;
    if (!ticker || !units) continue;

    try {
      const fetcher = getFecher(ticker, assetType);
      const { price, change24h } = await fetcher();

      const unitsNum = parseFloat(units);
      const costNum = parseFloat(costPerUnit);
      const priceNum = parseFloat(price);
      const currentValue = (unitsNum * priceNum).toFixed(2);
      const costBasis = (unitsNum * costNum).toFixed(2);
      const plAUD = (parseFloat(currentValue) - parseFloat(costBasis)).toFixed(2);
      const plPct = costNum > 0 ? (((priceNum - costNum) / costNum) * 100).toFixed(2) : "0.00";

      priceRows.push([ticker, name, units, costPerUnit, platform, assetType, price, change24h, currentValue, costBasis, plAUD, plPct, timestamp]);
      console.log(`✅ ${ticker}: $${price} AUD (${change24h}% 24h)`);

      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.error(`❌ Failed for ${ticker}:`, err.message);
      priceRows.push([ticker, name, units, costPerUnit, platform, assetType, "ERROR", "0", "0", "0", "0", "0", timestamp]);
    }
  }

  // Write all prices to Prices tab
  await writeSheet("Prices!A1", priceRows);
  console.log(`✅ Prices tab updated with ${priceRows.length - 1} holdings`);

  // Also update Balances summary in Config tab
  const totalValue = priceRows.slice(1)
    .filter(r => r[8] !== "0" && r[8] !== "ERROR")
    .reduce((sum, r) => sum + parseFloat(r[8]), 0)
    .toFixed(2);

  const totalCost = priceRows.slice(1)
    .filter(r => r[9] !== "0")
    .reduce((sum, r) => sum + parseFloat(r[9]), 0)
    .toFixed(2);

  const totalPL = (parseFloat(totalValue) - parseFloat(totalCost)).toFixed(2);

  console.log(`📈 Portfolio total: $${totalValue} AUD | P&L: $${totalPL}`);
  console.log("✅ Done:", new Date().toISOString());
}

main().catch(err => {
  console.error("💥 Fatal error:", err);
  process.exit(1);
});
