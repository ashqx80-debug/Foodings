// =============================================================
//  Grocery Deal Finder — backend server
//  Runs with plain Node.js 18+ (no npm install needed).
//  Start it with:  node server.js   then open http://localhost:3000
// =============================================================

const http = require("http");
const fs = require("fs");
const path = require("path");

// ---------- 1. Load settings from the .env file ----------
// (Keeps your secret keys out of the code.)
function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
}
loadEnv();

const PORT = process.env.PORT || 3000;
const KROGER_ID = process.env.KROGER_CLIENT_ID || "";
const KROGER_SECRET = process.env.KROGER_CLIENT_SECRET || "";
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";
const DEMO_MODE = !KROGER_ID || !KROGER_SECRET;

const MAX_ITEMS = 15; // most items per search
const MAX_STORES = 5; // most Kroger stores to check
const SEARCH_RADIUS_MILES = 15;

// ---------- 2. Kroger API helpers ----------
let krogerToken = null;
let krogerTokenExpires = 0;

// Kroger uses OAuth "client credentials": we trade our ID + secret for a
// short-lived token, and reuse it until it expires.
async function getKrogerToken() {
  if (krogerToken && Date.now() < krogerTokenExpires - 60_000) return krogerToken;
  const auth = Buffer.from(`${KROGER_ID}:${KROGER_SECRET}`).toString("base64");
  const res = await fetch("https://api.kroger.com/v1/connect/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials&scope=product.compact",
  });
  if (!res.ok) throw new Error(`Kroger login failed (${res.status}). Check your keys in .env`);
  const data = await res.json();
  krogerToken = data.access_token;
  krogerTokenExpires = Date.now() + data.expires_in * 1000;
  return krogerToken;
}

async function krogerGet(urlPath) {
  const token = await getKrogerToken();
  const res = await fetch(`https://api.kroger.com${urlPath}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Kroger request failed (${res.status})`);
  return res.json();
}

async function findKrogerStores(lat, lon) {
  const q = new URLSearchParams({
    "filter.latLong.near": `${lat},${lon}`,
    "filter.radiusInMiles": String(SEARCH_RADIUS_MILES),
    "filter.limit": String(MAX_STORES),
  });
  const data = await krogerGet(`/v1/locations?${q}`);
  return (data.data || []).map((s) => ({
    id: s.locationId,
    name: s.name,
    chain: s.chain,
    address: s.address
      ? `${s.address.addressLine1}, ${s.address.city}, ${s.address.state} ${s.address.zipCode}`
      : "",
    lat: s.geolocation?.latitude,
    lon: s.geolocation?.longitude,
  }));
}

async function searchKrogerProducts(term, storeId) {
  const q = new URLSearchParams({
    "filter.term": term,
    "filter.locationId": storeId,
    "filter.limit": "10",
  });
  const data = await krogerGet(`/v1/products?${q}`);
  const products = [];
  for (const p of data.data || []) {
    const item = (p.items || [])[0];
    if (!item || !item.price || !item.price.regular) continue; // no price at this store
    const regular = item.price.regular;
    const promo = item.price.promo && item.price.promo > 0 ? item.price.promo : null;
    products.push({
      name: p.description,
      brand: p.brand || "",
      size: item.size || "",
      regularPrice: regular,
      salePrice: promo,
      price: promo || regular,
      url: p.productPageURI ? `https://www.kroger.com${p.productPageURI}` : null,
      image: pickImage(p.images),
    });
  }
  return products;
}

function pickImage(images) {
  const front = (images || []).find((i) => i.perspective === "front") || (images || [])[0];
  if (!front) return null;
  const size = front.sizes.find((s) => s.size === "medium") || front.sizes[0];
  return size ? size.url : null;
}

// ---------- 3. Unit prices ----------
// Turns sizes like "64 fl oz", "1 gal", "2 lb", "12 ct" into a common unit
// so we can compare a big bottle against a small one fairly.
const UNIT_TABLE = {
  // weight -> ounces
  oz: ["oz", 1], ounce: ["oz", 1], lb: ["oz", 16], lbs: ["oz", 16], pound: ["oz", 16],
  g: ["oz", 0.035274], kg: ["oz", 35.274],
  // volume -> fluid ounces
  "fl oz": ["fl oz", 1], floz: ["fl oz", 1], gal: ["fl oz", 128], gallon: ["fl oz", 128],
  qt: ["fl oz", 32], quart: ["fl oz", 32], pt: ["fl oz", 16], pint: ["fl oz", 16],
  l: ["fl oz", 33.814], liter: ["fl oz", 33.814], ml: ["fl oz", 0.033814],
  // count -> each
  ct: ["each", 1], count: ["each", 1], ea: ["each", 1], each: ["each", 1], pk: ["each", 1],
};

function parseSize(sizeText) {
  if (!sizeText) return null;
  const text = sizeText.toLowerCase().replace(/\s+/g, " ");
  // handles "12 ct / 6 oz" style by taking the first match
  const m = text.match(/(\d+\/\d+|\d*\.?\d+)\s*(fl oz|floz|oz|ounce|lbs?|pound|kg|g|gal(?:lon)?|qt|quart|pt|pint|ml|l|liter|ct|count|ea|each|pk)\b/);
  if (!m) return null;
  // "1/2 gal" -> 0.5
  const amount = m[1].includes("/")
    ? Number(m[1].split("/")[0]) / Number(m[1].split("/")[1])
    : parseFloat(m[1]);
  const entry = UNIT_TABLE[m[2]] || UNIT_TABLE[m[2].replace(/s$/, "")];
  if (!entry || !amount) return null;
  return { amount: amount * entry[1], unit: entry[0] };
}

function addUnitPrice(product) {
  const size = parseSize(product.size);
  if (size) {
    product.unitPrice = product.price / size.amount;
    product.unit = size.unit;
  } else {
    product.unitPrice = null;
    product.unit = null;
  }
  return product;
}

// ---------- 4. AI: turn a messy shopping list into clean searches ----------
async function parseListWithAI(listText) {
  const prompt = `You help a grocery price-comparison website. Turn the shopping list below into store search terms.
Return ONLY a JSON array, no other text. Each element: {"label": what the user asked for, "search": a short 1-3 word grocery search term, "mustInclude": a word that should appear in matching product names (or ""), "exclude": [words that indicate the wrong product]}.
Example: "cheap 2% milk" -> {"label":"2% milk","search":"2% milk","mustInclude":"milk","exclude":["chocolate","almond","oat"]}
Max ${MAX_ITEMS} items. Shopping list:
${listText}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-5-5",
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`AI request failed (${res.status})`);
  const data = await res.json();
  const text = data.content.map((c) => c.text || "").join("");
  const json = text.slice(text.indexOf("["), text.lastIndexOf("]") + 1);
  const items = JSON.parse(json);
  return items.slice(0, MAX_ITEMS).map((i) => ({
    label: String(i.label || i.search),
    search: String(i.search || i.label),
    mustInclude: String(i.mustInclude || "").toLowerCase(),
    exclude: Array.isArray(i.exclude) ? i.exclude.map((w) => String(w).toLowerCase()) : [],
  }));
}

// Backup when there's no AI key: split on commas / new lines and strip numbers.
function parseListSimple(listText) {
  return listText
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_ITEMS)
    .map((raw) => {
      const search = raw
        .replace(/^(an?\s+)?(\d+(\.\d+)?\s*)?(x|lbs?|pounds?|oz|gal(lons?)?|dozen|pack|bags?|boxes?|cans?|bottles?|loaf|loaves)?\s+(of\s+)?/i, "")
        .replace(/\b(cheap|cheapest|some|a few|good)\b/gi, "")
        .trim() || raw;
      return { label: raw, search, mustInclude: "", exclude: [] };
    });
}

function matches(product, item) {
  const name = `${product.brand} ${product.name}`.toLowerCase();
  if (item.mustInclude && !name.includes(item.mustInclude)) return false;
  return !item.exclude.some((w) => w && name.includes(w));
}

// ---------- 5. The main search ----------
async function runSearch({ lat, lon, list }) {
  const usedAI = Boolean(ANTHROPIC_KEY);
  let items;
  try {
    items = usedAI ? await parseListWithAI(list) : parseListSimple(list);
  } catch (err) {
    console.warn("AI parsing failed, using simple parser:", err.message);
    items = parseListSimple(list);
  }
  if (!items.length) throw new Error("Type at least one item to search for.");

  if (DEMO_MODE) return demoSearch(items, usedAI);

  const stores = await findKrogerStores(lat, lon);
  if (!stores.length) {
    return { demo: false, usedAI, stores: [], results: [], storeTotals: [],
      message: `No Kroger-family stores found within ${SEARCH_RADIUS_MILES} miles yet. More chains coming soon!` };
  }

  // Search every item at every store at the same time.
  const results = await Promise.all(
    items.map(async (item) => {
      const perStore = await Promise.all(
        stores.map(async (store) => {
          try {
            const products = await searchKrogerProducts(item.search, store.id);
            return products.filter((p) => matches(p, item)).map((p) => ({ ...addUnitPrice(p), storeId: store.id }));
          } catch (err) {
            console.warn(`Search failed for "${item.search}" at ${store.name}:`, err.message);
            return [];
          }
        })
      );
      return rankItem(item, perStore.flat());
    })
  );

  return { demo: false, usedAI, stores, results, storeTotals: storeTotals(stores, results) };
}

// Best deal = lowest unit price when sizes are comparable, otherwise lowest price.
function rankItem(item, options) {
  const mainUnit = mostCommonUnit(options);
  options.sort((a, b) => {
    const aUnit = a.unit === mainUnit && a.unitPrice != null;
    const bUnit = b.unit === mainUnit && b.unitPrice != null;
    if (aUnit && bUnit) return a.unitPrice - b.unitPrice;
    if (aUnit !== bUnit) return aUnit ? -1 : 1;
    return a.price - b.price;
  });
  return { item: item.label, search: item.search, best: options[0] || null, others: options.slice(1, 6) };
}

function mostCommonUnit(options) {
  const counts = {};
  for (const o of options) if (o.unit) counts[o.unit] = (counts[o.unit] || 0) + 1;
  return Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || null;
}

// For "should I just go to one store?": cheapest matching item per store, added up.
function storeTotals(stores, results) {
  return stores
    .map((store) => {
      let total = 0;
      let found = 0;
      for (const r of results) {
        const all = [r.best, ...r.others].filter((o) => o && o.storeId === store.id);
        if (all.length) {
          total += Math.min(...all.map((o) => o.price));
          found++;
        }
      }
      return { storeId: store.id, name: store.name, total: Math.round(total * 100) / 100, found, of: results.length };
    })
    .sort((a, b) => b.found - a.found || a.total - b.total);
}

// ---------- 6. Demo mode (no Kroger keys yet) ----------
// Made-up stores and prices so you can test the website. The page shows a
// big "DEMO DATA" banner so nobody mistakes these for real prices.
function demoSearch(items, usedAI) {
  const stores = [
    { id: "demo-a", name: "Demo Store A", chain: "DEMO", address: "Sample data — not a real store" },
    { id: "demo-b", name: "Demo Store B", chain: "DEMO", address: "Sample data — not a real store" },
    { id: "demo-c", name: "Demo Store C", chain: "DEMO", address: "Sample data — not a real store" },
  ];
  const sizes = ["16 oz", "32 oz", "1 lb", "64 fl oz", "12 ct"];
  const results = items.map((item, i) => {
    const options = [];
    stores.forEach((store, s) => {
      for (let k = 0; k < 2; k++) {
        const seed = (item.search.length * 7 + s * 13 + k * 5 + i) % 17;
        const regular = Math.round((1.49 + seed * 0.37) * 100) / 100;
        const onSale = seed % 4 === 0;
        const salePrice = onSale ? Math.round(regular * 0.8 * 100) / 100 : null;
        options.push(addUnitPrice({
          name: `${k ? "Store Brand" : "Name Brand"} ${item.search}`,
          brand: k ? "Store Brand" : "Name Brand",
          size: sizes[(seed + k) % 2 === 0 ? 0 : 1],
          regularPrice: regular, salePrice, price: salePrice || regular,
          url: null, image: null, storeId: store.id,
        }));
      }
    });
    return rankItem(item, options);
  });
  return { demo: true, usedAI, stores, results, storeTotals: storeTotals(stores, results) };
}

// ---------- 7. Web server ----------
const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json",
};

function sendJSON(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/api/status") {
    return sendJSON(res, 200, { demo: DEMO_MODE, ai: Boolean(ANTHROPIC_KEY) });
  }

  if (req.method === "POST" && url.pathname === "/api/search") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 20_000) req.destroy(); // ignore giant requests
    });
    req.on("end", async () => {
      try {
        const { lat, lon, list } = JSON.parse(body || "{}");
        if (typeof lat !== "number" || typeof lon !== "number") throw new Error("Missing location.");
        if (!list || typeof list !== "string") throw new Error("Type at least one item to search for.");
        sendJSON(res, 200, await runSearch({ lat, lon, list: list.slice(0, 2000) }));
      } catch (err) {
        console.error(err);
        sendJSON(res, 400, { error: err.message });
      }
    });
    return;
  }

  // Serve files from the /public folder
  const safePath = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  let filePath = path.join(__dirname, "public", safePath === "/" ? "index.html" : safePath);
  if (!filePath.startsWith(path.join(__dirname, "public"))) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end("Not found");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`\n  Grocery Deal Finder running at http://localhost:${PORT}`);
  console.log(DEMO_MODE
    ? "  Mode: DEMO (add Kroger keys to .env for real prices)"
    : "  Mode: LIVE — real Kroger prices");
  console.log(ANTHROPIC_KEY ? "  AI list reading: ON\n" : "  AI list reading: OFF (simple parser)\n");
});
