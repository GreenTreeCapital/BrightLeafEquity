/**
 * Green Bull Capital — Update performance.json from holdings.json
 * - Reads /data/holdings.json
 * - Fetches latest prices from Alpha Vantage (GLOBAL_QUOTE)
 * - Writes /data/performance.json with holdings + latest index point
 * - ONE-TIME BACKFILL: ensures at least 52 weekly points for charts (fictitious, deterministic)
 */

const fs = require("fs");

const API_KEY = process.env.ALPHAVANTAGE_API_KEY;

// -----------------------------
// Alpha Vantage helpers
// -----------------------------
async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.json();
}

async function getAlphaVantagePrice(symbol) {
  const url =
    `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(symbol)}&apikey=${API_KEY}`;

  const data = await fetchJson(url);

  if (data.Note) throw new Error("Alpha Vantage rate limit: " + data.Note);
  if (data["Error Message"]) throw new Error("Alpha Vantage error: " + data["Error Message"]);

  const quote = data["Global Quote"];
  if (!quote || !quote["05. price"]) throw new Error("No quote returned for " + symbol);

  const price = Number(quote["05. price"]);
  if (!Number.isFinite(price)) throw new Error("Invalid price for " + symbol);

  return price;
}

// -----------------------------
// Date helpers (weekly labels)
// -----------------------------
function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

// Returns the most recent Friday (UTC) on or before "now"
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

// Creates an array of weekly ISO labels ending at endDate (inclusive), going back N-1 weeks
function buildWeeklyLabels(endDate, weeks) {
  const labels = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const dd = subtractDaysUTC(endDate, i * 7);
    labels.push(isoDate(dd));
  }
  return labels;
}

// -----------------------------
// Deterministic PRNG for backfill (so it doesn’t change every run)
// -----------------------------
function xfnv1a(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  return function () {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// -----------------------------
// Index helpers
// -----------------------------
function normalizeIndex(enrichedHoldings) {
  // Portfolio "price" = sum(weight * price)
  return enrichedHoldings.reduce((sum, h) => sum + (h.weight * (h.price ?? 0)), 0);
}

// ONE-TIME BACKFILL: generate 52 weekly points that end at currentIndex,
// start at 100, with choppy path (deterministic)
function backfillWeeklyIndex({ endLabel, endIndex, weeks = 52, seedKey = "default" }) {
  const seed = xfnv1a(seedKey + "|" + endLabel + "|" + String(endIndex));
  const rand = mulberry32(seed);

  // Build labels ending at the current label
  const endDate = new Date(endLabel + "T00:00:00Z");
  const labels = buildWeeklyLabels(endDate, weeks);

  // Create a choppy path from 100 -> endIndex
  // We create weekly returns around a drift that achieves the endIndex target.
  const startIndex = 100;
  const target = endIndex;

  // If target is too close, still make it choppy but end correct
  const points = [startIndex];

  // Compute average multiplicative weekly drift needed
  const drift = Math.pow(target / startIndex, 1 / (weeks - 1)); // multiplier per week

  for (let i = 1; i < weeks; i++) {
    // volatility: +/- ~1.5% typical, occasional larger move
    const baseVol = 0.015;
    const shock = (rand() < 0.08) ? 0.035 : 0.0; // 8% chance larger move
    const vol = baseVol + shock;

    // Random noise in [-vol, +vol]
    const noise = (rand() * 2 - 1) * vol;

    // Apply drift and noise
    const prev = points[i - 1];
    const next = prev * drift * (1 + noise);
    points.push(next);
  }

  // Rescale entire series so last point matches target exactly
  const scale = target / points[points.length - 1];
  const scaled = points.map(v => Number((v * scale).toFixed(4)));

  return { labels, index: scaled };
}

// -----------------------------
// Main
// -----------------------------
(async () => {
  if (!API_KEY) {
    console.error("Missing ALPHAVANTAGE_API_KEY. Add it in GitHub Secrets or workflow env.");
    process.exit(1);
  }

  const holdingsPath = "data/holdings.json";
  const perfPath = "data/performance.json";

  if (!fs.existsSync(holdingsPath)) {
    console.error("Missing data/holdings.json");
    process.exit(1);
  }

  const holdingsData = JSON.parse(fs.readFileSync(holdingsPath, "utf8"));
  const holdings = holdingsData.holdings || [];

  // Fetch prices
  const enriched = [];
  for (const h of holdings) {
    const ticker = String(h.ticker || "").trim();
    const upper = ticker.toUpperCase();

    // Only treat clearly pseudo tickers as pseudo (DO NOT use "-" because BRK-B etc exist)
    const isPseudo =
      upper.includes("CASH") ||
      upper.includes("HEDGE") ||
      upper === "USD" ||
      upper === "USD-CASH";

    if (isPseudo || !ticker) {
      enriched.push({ ...h, price: null });
      continue;
    }

    try {
      const price = await getAlphaVantagePrice(ticker);
      enriched.push({ ...h, price });

      // Free tier pacing
      await new Promise(r => setTimeout(r, 13000));
    } catch (e) {
      enriched.push({ ...h, price: null, error: String(e.message || e) });
      console.warn("Price fetch failed:", ticker, e.message || e);
    }
  }

  // Load existing perf
  let perf = { labels: [], longTermIndex: [], latest: { index: 100, changePct: 0 }, holdings: [] };
  if (fs.existsSync(perfPath)) {
    try { perf = JSON.parse(fs.readFileSync(perfPath, "utf8")); } catch {}
  }

  // Compute portfolio price and index
  const portfolioPrice = normalizeIndex(enriched);

  if (!perf._baselinePortfolioPrice) {
    perf._baselinePortfolioPrice = portfolioPrice || 1;
  }

  const baseline = perf._baselinePortfolioPrice || 1;
  const indexValue = baseline ? (portfolioPrice / baseline) * 100 : 100;

  // Weekly label: use most recent Friday (UTC), so you get exactly 1 point per week
  const friday = mostRecentFridayUTC(new Date());
  const t = isoDate(friday);

  perf.labels = Array.isArray(perf.labels) ? perf.labels : [];
  perf.longTermIndex = Array.isArray(perf.longTermIndex) ? perf.longTermIndex : [];

  // ONE-TIME BACKFILL: Ensure at least 52 weekly points (fictitious) so the chart looks “complete”
  // This only runs once, and is flagged in the JSON.
  const NEED_WEEKS = 52;
  if (!perf._backfilledWeekly52 && perf.labels.length < NEED_WEEKS) {
    const seedKey = "GreenBullCapital|weekly52";
    const backfill = backfillWeeklyIndex({
      endLabel: t,
      endIndex: Number(indexValue.toFixed(4)),
      weeks: NEED_WEEKS,
      seedKey
    });

    perf.labels = backfill.labels;
    perf.longTermIndex = backfill.index;

    perf._backfilledWeekly52 = true;
    perf._backfillNote = "Backfilled 52 weekly index points (fictitious, deterministic) to provide a complete 12-month chart.";
  }

  // Append new point if the last label isn't this week's label
  const lastLabel = perf.labels[perf.labels.length - 1];
  if (lastLabel !== t) {
    perf.labels.push(t);
    perf.longTermIndex.push(Number(indexValue.toFixed(4)));
  } else {
    // If we already have this week's label, update the last value to the newest index
    perf.longTermIndex[perf.longTermIndex.length - 1] = Number(indexValue.toFixed(4));
  }

  const first = perf.longTermIndex[0] ?? 100;
  const changePct = ((indexValue / first) - 1) * 100;

  perf.latest = {
    index: Number(indexValue.toFixed(2)),
    changePct: Number(changePct.toFixed(2))
  };

  // Write holdings so the page can read one file
  perf.holdings = enriched.map(h => ({
    ticker: h.ticker,
    name: h.name,
    weight: h.weight,
    price: (h.price == null ? null : Number(h.price)),
    assetClass: h.assetClass,
    region: h.region
  }));

  fs.writeFileSync(perfPath, JSON.stringify(perf, null, 2));
  console.log("Updated", perfPath);
})();
