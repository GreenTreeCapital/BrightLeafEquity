/**
 * Green Bull Capital — Update performance.json from holdings.json
 * - Reads /data/holdings.json
 * - Fetches latest prices from Alpha Vantage (GLOBAL_QUOTE)
 * - Writes /data/performance.json with holdings + latest index point
 */

const fs = require("fs");

const API_KEY = process.env.ALPHAVANTAGE_API_KEY;

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.json();
}

async function getAlphaVantagePrice(symbol) {
  const url =
    `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(symbol)}&apikey=${API_KEY}`;

  const data = await fetchJson(url);

  // Handle rate limit / invalid responses
  if (data.Note) throw new Error("Alpha Vantage rate limit: " + data.Note);
  if (data["Error Message"]) throw new Error("Alpha Vantage error: " + data["Error Message"]);

  const quote = data["Global Quote"];
  if (!quote || !quote["05. price"]) throw new Error("No quote returned for " + symbol);

  const price = Number(quote["05. price"]);
  if (!Number.isFinite(price)) throw new Error("Invalid price for " + symbol);

  return price;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeIndex(enrichedHoldings) {
  // We want an index starting at 100. To do that, we store the first "portfolio price"
  // and then scale later values vs that baseline.
  // Here we compute "portfolio price" as sum(weight * price). (Not NAV in dollars.)
  return enrichedHoldings.reduce((sum, h) => sum + (h.weight * (h.price ?? 0)), 0);
}

(async () => {
  if (!API_KEY) {
    console.error("Missing ALPHAVANTAGE_API_KEY. Add it in GitHub Secrets.");
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

  // Fetch prices for tickers (skip pseudo tickers like USD-CASH)
  const enriched = [];
  for (const h of holdings) {
    const ticker = h.ticker;

    // Skip pseudo holdings (cash/hedges) — keep them in the table with price null
    const isPseudo = ticker.includes("CASH") || ticker.includes("HEDGE") || ticker.includes("-");
    if (isPseudo) {
      enriched.push({ ...h, price: null });
      continue;
    }

    try {
      // Alpha Vantage is rate-limited. Sleep a bit between calls.
      const price = await getAlphaVantagePrice(ticker);
      enriched.push({ ...h, price });

      // 13 seconds spacing to stay safer on free tier
      await new Promise(r => setTimeout(r, 13000));
    } catch (e) {
      // Don’t fail the whole run; keep holding but with null price
      enriched.push({ ...h, price: null, error: String(e.message || e) });
      console.warn("Price fetch failed:", ticker, e.message || e);
    }
  }

  // Load existing perf
  let perf = { labels: [], longTermIndex: [], latest: { index: 100, changePct: 0 }, holdings: [] };
  if (fs.existsSync(perfPath)) {
    try {
      perf = JSON.parse(fs.readFileSync(perfPath, "utf8"));
    } catch {}
  }

  // Compute portfolio "price"
  const portfolioPrice = normalizeIndex(enriched);

  // Establish baseline
  if (!perf._baselinePortfolioPrice) {
    perf._baselinePortfolioPrice = portfolioPrice || 1;
  }

  const baseline = perf._baselinePortfolioPrice || 1;
  const indexValue = baseline ? (portfolioPrice / baseline) * 100 : 100;

  // Add new point if today not already included
  const t = todayISO();
  perf.labels = Array.isArray(perf.labels) ? perf.labels : [];
  perf.longTermIndex = Array.isArray(perf.longTermIndex) ? perf.longTermIndex : [];

  const lastLabel = perf.labels[perf.labels.length - 1];
  if (lastLabel !== t) {
    perf.labels.push(t);
    perf.longTermIndex.push(Number(indexValue.toFixed(4)));
  }

  const first = perf.longTermIndex[0] ?? 100;
  const changePct = ((indexValue / first) - 1) * 100;

  perf.latest = {
    index: Number(indexValue.toFixed(2)),
    changePct: Number(changePct.toFixed(2))
  };

  // Write full holdings to perf (so the webpage can read one file)
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
