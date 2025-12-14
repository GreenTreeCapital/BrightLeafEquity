/**
 * Green Bull Capital — Build performance.json from holdings.json using REAL historical data
 *
 * - Reads:  data/holdings.json
 * - Fetches weekly adjusted history per ticker from Alpha Vantage:
 *     TIME_SERIES_WEEKLY_ADJUSTED (stocks/ETFs)
 * - Builds last 52 weekly portfolio index points (weights assumed constant)
 * - Writes: data/performance.json
 * - Caches per-ticker history in: data/cache/<TICKER>.json
 */

const fs = require("fs");
const path = require("path");

const API_KEY = process.env.ALPHAVANTAGE_API_KEY;

const HOLDINGS_PATH = "data/holdings.json";
const PERF_PATH = "data/performance.json";
const CACHE_DIR = "data/cache";

// Alpha Vantage free tier is rate limited; keep calls spaced
const API_CALL_DELAY_MS = 13000; // ~13s between calls is safer on free tier

// -----------------------------
// Utilities
// -----------------------------
function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function readJsonSafe(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function mostRecentFridayUTC(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = d.getUTCDay(); // Sun=0 ... Fri=5
  const diff = (day >= 5) ? (day - 5) : (7 - (5 - day));
  d.setUTCDate(d.getUTCDate() - diff);
  return d;
}

function subtractDaysUTC(d, days) {
  const x = new Date(d.getTime());
  x.setUTCDate(x.getUTCDate() - days);
  return x;
}

function buildWeeklyLabels(endFriday, weeks = 52) {
  const labels = [];
  for (let i = weeks - 1; i >= 0; i--) {
    labels.push(isoDate(subtractDaysUTC(endFriday, i * 7)));
  }
  return labels;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.json();
}

// -----------------------------
// Alpha Vantage weekly adjusted (stocks/ETFs)
// -----------------------------
async function fetchWeeklyAdjustedSeries(symbol) {
  const url =
    `https://www.alphavantage.co/query?function=TIME_SERIES_WEEKLY_ADJUSTED&symbol=${encodeURIComponent(symbol)}&apikey=${API_KEY}`;

  const data = await fetchJson(url);

  if (data.Note) throw new Error("Alpha Vantage rate limit: " + data.Note);
  if (data["Error Message"]) throw new Error("Alpha Vantage error: " + data["Error Message"]);

  const series = data["Weekly Adjusted Time Series"];
  if (!series) throw new Error("No Weekly Adjusted Time Series returned for " + symbol);

  // Map: date -> adjusted close
  const out = {};
  for (const [date, row] of Object.entries(series)) {
    const adj = Number(row["5. adjusted close"]);
    if (Number.isFinite(adj)) out[date] = adj;
  }
  return out;
}

// Cache format: { fetchedAt: "ISO", series: { "YYYY-MM-DD": price, ... } }
function cachePathFor(symbol) {
  return path.join(CACHE_DIR, `${symbol.toUpperCase()}.json`);
}

function cacheIsFresh(cacheObj, maxAgeHours = 24) {
  if (!cacheObj || !cacheObj.fetchedAt) return false;
  const t = Date.parse(cacheObj.fetchedAt);
  if (!Number.isFinite(t)) return false;
  const ageMs = Date.now() - t;
  return ageMs < maxAgeHours * 3600 * 1000;
}

// Find the last available weekly price on or before a target date
function priceOnOrBefore(seriesObj, targetISO) {
  if (!seriesObj) return null;

  // Alpha Vantage keys are ISO dates; get all keys once
  const dates = Object.keys(seriesObj);
  if (!dates.length) return null;

  // We want most recent <= target
  // dates are not guaranteed sorted, so sort descending once per call (small enough for weekly series)
  dates.sort((a, b) => (a < b ? 1 : -1));

  for (const d of dates) {
    if (d <= targetISO) return seriesObj[d];
  }
  return null;
}

// Portfolio "price" at a point in time = sum(weight * price)
function portfolioPriceAtDate(holdings, seriesByTicker, dateISO) {
  let total = 0;
  let coveredWeight = 0;

  for (const h of holdings) {
    const w = Number(h.weight) || 0;
    const t = String(h.ticker || "").trim().toUpperCase();
    if (!t || w <= 0) continue;

    const series = seriesByTicker[t];
    const px = priceOnOrBefore(series, dateISO);

    if (px != null && Number.isFinite(px)) {
      total += w * px;
      coveredWeight += w;
    } else {
      // If missing data, just skip that holding’s contribution
      // (You could also choose to carry-forward or halt, but this is robust.)
    }
  }

  return { total, coveredWeight };
}

// -----------------------------
// Main
// -----------------------------
(async () => {
  if (!API_KEY) {
    console.error("Missing ALPHAVANTAGE_API_KEY");
    process.exit(1);
  }

  if (!fs.existsSync(HOLDINGS_PATH)) {
    console.error("Missing data/holdings.json");
    process.exit(1);
  }

  ensureDir(CACHE_DIR);

  const holdingsData = readJsonSafe(HOLDINGS_PATH, { holdings: [] });
  const holdingsRaw = Array.isArray(holdingsData.holdings) ? holdingsData.holdings : [];

  // Filter pseudo holdings (cash/hedges). IMPORTANT: DO NOT treat "-" as pseudo (BRK-B exists).
  const holdings = holdingsRaw.filter(h => {
    const t = String(h.ticker || "").toUpperCase();
    if (!t) return false;
    if (t.includes("CASH") || t.includes("HEDGE") || t === "USD" || t === "USD-CASH") return false;
    return true;
  }).map(h => ({
    ...h,
    ticker: String(h.ticker).toUpperCase(),
    weight: Number(h.weight) || 0
  }));

  // -----------------------------
  // Fetch/cached weekly series per ticker
  // -----------------------------
  const seriesByTicker = {};
  const latestPriceByTicker = {};

  for (const h of holdings) {
    const ticker = h.ticker;
    const cPath = cachePathFor(ticker);
    const cached = readJsonSafe(cPath, null);

    let series = null;
    try {
      if (cacheIsFresh(cached, 24) && cached.series) {
        series = cached.series;
      } else {
        series = await fetchWeeklyAdjustedSeries(ticker);
        writeJson(cPath, { fetchedAt: new Date().toISOString(), series });
        await sleep(API_CALL_DELAY_MS);
      }
    } catch (e) {
      console.warn(`[WARN] ${ticker}: ${String(e.message || e)}`);
      // If fetch fails but cache exists, fall back to cache even if stale
      if (cached && cached.series) series = cached.series;
    }

    seriesByTicker[ticker] = series;

    // Latest available weekly price
    const keys = series ? Object.keys(series) : [];
    if (keys.length) {
      keys.sort((a, b) => (a < b ? 1 : -1));
      latestPriceByTicker[ticker] = series[keys[0]];
    } else {
      latestPriceByTicker[ticker] = null;
    }
  }

  // -----------------------------
  // Build last 52 weekly index points from REAL prices
  // -----------------------------
  const endFriday = mostRecentFridayUTC(new Date());
  const labels = buildWeeklyLabels(endFriday, 52);

  // Compute portfolio “price” each week
  const weeklyPrices = labels.map(d => portfolioPriceAtDate(holdings, seriesByTicker, d));

  // If lots of data missing, your index could be distorted; we’ll still compute but track coverage.
  const firstNonZero = weeklyPrices.find(p => p.total > 0) || { total: 1, coveredWeight: 0 };
  const baselinePortfolioPrice = firstNonZero.total || 1;

  const longTermIndex = weeklyPrices.map(p => {
    const idx = (p.total / baselinePortfolioPrice) * 100;
    return Number(idx.toFixed(4));
  });

  const latestIndex = longTermIndex[longTermIndex.length - 1];
  const firstIndex = longTermIndex[0] || 100;
  const changePct = ((latestIndex / firstIndex) - 1) * 100;

  // -----------------------------
  // Output holdings for website table
  // -----------------------------
  const enrichedHoldings = holdingsRaw.map(h => {
    const t = String(h.ticker || "").toUpperCase();
    const w = Number(h.weight) || 0;
    const px = t ? latestPriceByTicker[t] : null;

    return {
      ticker: h.ticker,
      name: h.name,
      weight: w,
      price: (px == null ? null : Number(px)),
      assetClass: h.assetClass,
      region: h.region
    };
  });

  const perf = {
    baseCurrency: holdingsData.baseCurrency || "USD",
    baseIndex: holdingsData.baseIndex || 100,

    // Real weekly history (last 52 Fridays)
    labels,
    longTermIndex,

    latest: {
      index: Number(latestIndex.toFixed(2)),
      changePct: Number(changePct.toFixed(2))
    },

    // Used by your webpage holdings table + pie chart
    holdings: enrichedHoldings,

    // Metadata (useful for debugging / transparency)
    _historySource: "AlphaVantage: TIME_SERIES_WEEKLY_ADJUSTED",
    _historyAsOfFridayUTC: isoDate(endFriday),
    _baselinePortfolioPrice: Number(baselinePortfolioPrice.toFixed(6))
  };

  writeJson(PERF_PATH, perf);
  console.log("Updated", PERF_PATH);
})();
