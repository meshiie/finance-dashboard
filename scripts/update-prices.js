import { google } from "googleapis";

const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

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

// Yahoo Finance — normalises ticker to Yahoo format
// ASX tickers: NDQ.AX, AMP.AX, COH.AX etc (Yahoo always uses .AX not .ASX)
async function fetchYahooPrice(ticker) {
  // Normalise: strip .ASX and replace with .AX, ensure .AX suffix
  let yahooTicker = ticker
    .replace(/\.ASX$/i, ".AX")
    .replace(/\.asx$/i, ".AX");
  if (!yahooTicker.includes(".")) yahooTicker = yahooTicker + ".AX";

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooTicker}?interval=1d&range=2d`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!res.ok) throw new Error(`Yahoo ${yahooTicker}: HTTP ${res.status}`);
  const data = await res.json();
  if (!data.chart?.result?.[0]) throw new Error(`Yahoo ${yahooTicker}: no data`);
  const meta = data.chart.result[0].meta;
  const price = meta.regularMarketPrice;
  const prev = meta.chartPreviousClose;
  const change24h = prev ? (((price - prev) / prev) * 100).toFixed(2) : "0.00";
  return { price: price.toFixed(4), change24h };
}

// CoinGecko — free, no key needed
async function fetchCoinGeckoPrice(coinId) {
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=aud&include_24hr_change=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CoinGecko ${coinId}: HTTP ${res.status}`);
  const data = await res.json();
  const price = data[coinId]?.aud;
  if (!price) throw new Error(`CoinGecko ${coinId}: no price data`);
  const change24h = data[coinId].aud_24h_change?.toFixed(2) ?? "0.00";
  return { price: price.toFixed(4), change24h };
}

const CRYPTO_IDS = {
  SOL: "solana",
  BTC: "bitcoin",
  ETH: "ethereum",
};

async function main() {
  console.log("📊 Starting price update:", new Date().toISOString());

  const holdings = await readSheet("HOLDINGS!A:F");
  const rows = holdings.slice(1).filter((r) => r[0]);

  const timestamp = new Date().toLocaleString("en-AU", {
    timeZone: "Australia/Sydney",
    dateStyle: "short",
    timeStyle: "short",
  });

  const priceRows = [[
    "Ticker", "Name", "Units", "Cost_Per_Unit", "Platform", "Asset_Type",
    "Price_AUD", "Change_24h_Pct", "Current_Value", "Cost_Basis",
    "PL_AUD", "PL_Pct", "Last_Updated",
  ]];

  for (const row of rows) {
    // Handle both 'Asset_Type' and 'Asset Type' column naming
    const [ticker, name, units, costPerUnit, platform, assetType] = row;
    if (!ticker || !units) continue;

    const assetTypeCleaned = (assetType || "").toString().trim().toUpperCase();
    const isCrypto = assetTypeCleaned === "CRYPTO";

    try {
      let result;
      if (isCrypto) {
        const coinId = CRYPTO_IDS[ticker.toUpperCase()];
        if (!coinId) throw new Error(`Unknown crypto ticker: ${ticker}`);
        result = await fetchCoinGeckoPrice(coinId);
      } else {
        result = await fetchYahooPrice(ticker);
      }

      const { price, change24h } = result;
      const unitsNum = parseFloat(units);
      const costNum = parseFloat(costPerUnit) || 0;
      const priceNum = parseFloat(price);
      const currentValue = (unitsNum * priceNum).toFixed(2);
      const costBasis = (unitsNum * costNum).toFixed(2);
      const plAUD = (parseFloat(currentValue) - parseFloat(costBasis)).toFixed(2);
      const plPct = costNum > 0
        ? (((priceNum - costNum) / costNum) * 100).toFixed(2)
        : "0.00";

      priceRows.push([
        ticker, name, units, costPerUnit, platform, assetType,
        price, change24h, currentValue, costBasis, plAUD, plPct, timestamp,
      ]);
      console.log(`✅ ${ticker}: $${price} AUD (${change24h}% 24h)`);
    } catch (err) {
      console.error(`❌ ${ticker}: ${err.message}`);
      priceRows.push([
        ticker, name, units, costPerUnit, platform, assetType,
        "ERROR", "0", "0", "0", "0", "0", timestamp,
      ]);
    }

    await new Promise((r) => setTimeout(r, 600));
  }

  await writeSheet("Prices!A1", priceRows);

  const totalValue = priceRows.slice(1)
    .filter((r) => r[8] !== "0" && r[8] !== "ERROR")
    .reduce((s, r) => s + parseFloat(r[8]), 0);
  const totalCost = priceRows.slice(1)
    .reduce((s, r) => s + parseFloat(r[9] || 0), 0);

  console.log(`📈 Portfolio: $${totalValue.toFixed(2)} | P&L: $${(totalValue - totalCost).toFixed(2)}`);
  console.log("✅ Prices updated:", new Date().toISOString());
}

main().catch((err) => {
  console.error("💥 Fatal:", err);
  process.exit(1);
});
