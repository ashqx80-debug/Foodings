// =============================================================
//  FairCart — browser code
//  1) gets the user's location  2) shows nearby stores on a map
//  3) sends the shopping list to our server and shows the deals
// =============================================================

const $ = (id) => document.getElementById(id);
const state = { lat: null, lon: null, map: null, markers: null, cartoKey: null };

// Make text safe to put into HTML (stops broken pages and code injection).
function esc(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
const money = (n) => `$${Number(n).toFixed(2)}`;

function setStatus(msg, isError = false) {
  const el = $("locStatus");
  el.innerHTML = msg;
  el.classList.toggle("error", isError);
}

// ---------- Server status (demo mode? AI on?) ----------
fetch("/api/status")
  .then((r) => r.json())
  .then((s) => {
    $("demoBanner").hidden = !s.demo;
    state.cartoKey = s.cartoKey;
    $("aiHint").textContent = s.ai
      ? "AI reads your list, so write it however you like."
      : "Tip: separate items with commas.";
  })
  .catch(() => {});

// ---------- Step 1: location ----------
$("useLocation").addEventListener("click", () => {
  if (!navigator.geolocation) {
    setStatus("Your browser can't share location. Type your ZIP code instead.", true);
    return;
  }
  setStatus('<span class="spinner"></span>Finding you…');
  navigator.geolocation.getCurrentPosition(
    (pos) => setLocation(pos.coords.latitude, pos.coords.longitude, "your location"),
    () => setStatus("We couldn't get your location. Type your ZIP code instead.", true),
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
  );
});

$("zipForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const zip = $("zip").value.trim();
  if (!/^\d{5}$/.test(zip)) {
    setStatus("Please enter a 5-digit ZIP code.", true);
    return;
  }
  setStatus('<span class="spinner"></span>Looking up ZIP code…');
  try {
    // Nominatim = OpenStreetMap's free address lookup
    const r = await fetch(`https://nominatim.openstreetmap.org/search?postalcode=${zip}&country=us&format=json&limit=1`);
    const data = await r.json();
    if (!data.length) throw new Error("not found");
    setLocation(parseFloat(data[0].lat), parseFloat(data[0].lon), `ZIP ${zip}`);
  } catch {
    setStatus("We couldn't find that ZIP code. Try another one.", true);
  }
});

function setLocation(lat, lon, label) {
  state.lat = lat;
  state.lon = lon;
  $("searchBtn").disabled = false;
  setStatus(`Got it, searching near ${esc(label)}.`);
  findNearbyStores(lat, lon);
}

// Asks our server for grocery stores near a point (it uses OpenStreetMap data).
async function findNearbyStores(lat, lon) {
  $("storesArea").hidden = false;
  $("storeCount").textContent = "Finding nearby grocery stores…";
  $("storeList").innerHTML = "";
  showMap(lat, lon);
  try {
    const r = await fetch(`/api/stores?lat=${lat}&lon=${lon}`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    const stores = data.stores
      .map((s) => ({ ...s, miles: distanceMiles(lat, lon, s.lat, s.lon) }))
      .sort((a, b) => a.miles - b.miles);
    showStores(stores);
  } catch (err) {
    $("storeCount").textContent = `Couldn't load nearby stores right now (you can still search prices). ${err.message || ""}`;
  }
}

function showMap(lat, lon) {
  if (!window.L) return; // map library didn't load
  if (!state.map) {
    state.map = L.map("map", { scrollWheelZoom: false });
    const osmCredit = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
    if (state.cartoKey) {
      // CARTO map (free key, more reliable for websites)
      L.tileLayer(`https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png?key=${encodeURIComponent(state.cartoKey)}`, {
        maxNativeZoom: 18,
        maxZoom: 20,
        attribution: `${osmCredit}, © <a href="https://carto.com/attribution/">CARTO</a>`,
      }).addTo(state.map);
    } else {
      // OpenStreetMap's volunteer servers. They require the page address
      // ("referrer") to be sent, so we turn that on explicitly.
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        referrerPolicy: "strict-origin-when-cross-origin",
        attribution: osmCredit,
      }).addTo(state.map);
    }
    state.markers = L.layerGroup().addTo(state.map);
  }
  state.map.setView([lat, lon], 12);
  state.markers.clearLayers();
  L.circleMarker([lat, lon], { radius: 8, color: "#fff", weight: 3, fillColor: "#2563eb", fillOpacity: 1 })
    .bindPopup("You are here")
    .addTo(state.markers);
}

function showStores(stores) {
  $("storeCount").textContent = stores.length
    ? `${stores.length} grocery stores within 5 miles`
    : "No grocery stores found within 5 miles";
  $("storeList").innerHTML = stores
    .slice(0, 40)
    .map((s) => `<li>${esc(s.name)} <span class="dist">${s.miles.toFixed(1)} mi</span></li>`)
    .join("");
  if (state.markers) {
    stores.forEach((s) =>
      L.marker([s.lat, s.lon]).bindPopup(`<b>${esc(s.name)}</b><br>${s.miles.toFixed(1)} miles away`).addTo(state.markers)
    );
  }
}

function distanceMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ---------- Step 2 + 3: search and show results ----------
$("listForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const list = $("list").value.trim();
  const out = $("results");
  if (!list) {
    $("list").focus();
    return;
  }
  if (state.lat == null) {
    setStatus("First tell us where you are (step 1).", true);
    return;
  }
  out.hidden = false;
  out.innerHTML = '<div class="card"><span class="spinner"></span>Checking prices at nearby stores… this can take a few seconds.</div>';
  $("searchBtn").disabled = true;
  try {
    const r = await fetch("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lat: state.lat, lon: state.lon, list }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Something went wrong.");
    renderResults(data);
  } catch (err) {
    out.innerHTML = `<div class="card status error">${esc(err.message)}</div>`;
  } finally {
    $("searchBtn").disabled = false;
  }
});

function renderResults(data) {
  const out = $("results");
  if (data.message && !data.results.length) {
    out.innerHTML = `<div class="banner info">${esc(data.message)}</div>`;
    return;
  }
  const storeName = (id) => (data.stores.find((s) => s.id === id) || {}).name || "Store";

  // Total if you buy each item wherever it's cheapest
  const bestTotal = data.results.reduce((sum, r) => sum + (r.best ? r.best.price : 0), 0);
  const foundCount = data.results.filter((r) => r.best).length;
  const oneStore = data.storeTotals[0];
  // Sale savings included in your best deals
  const onSale = data.results.filter((r) => r.best && r.best.salePrice);
  const totalSavings = onSale.reduce((sum, r) => sum + r.best.savings, 0);

  let html = `<h2>Your best deals</h2>
    <div class="summary">
      <div class="sum-box best">
        <div class="label">Cheapest way to buy it all</div>
        <div class="big">${money(bestTotal)}</div>
        <div class="unit">Found ${foundCount} of ${data.results.length} items, buying each where it's cheapest</div>
      </div>`;
  if (oneStore && oneStore.found) {
    html += `<div class="sum-box">
        <div class="label">Best single store</div>
        <div class="big">${money(oneStore.total)}</div>
        <div class="unit">${esc(oneStore.name)}: has ${oneStore.found} of ${oneStore.of} items in stock</div>
      </div>`;
  }
  if (onSale.length) {
    html += `<div class="sum-box sale">
        <div class="label">Sales you're getting</div>
        <div class="big">${money(totalSavings)} off</div>
        <div class="unit">${onSale.length} of your best deals ${onSale.length === 1 ? "is" : "are"} on sale right now</div>
      </div>`;
  }
  html += `</div>`;

  for (const r of data.results) {
    html += `<article class="item">
      <div class="item-head"><h3>${esc(r.item)}</h3>${r.search.toLowerCase() !== r.item.toLowerCase() ? `<span class="searched">searched “${esc(r.search)}”</span>` : ""}</div>`;
    if (!r.best) {
      html += `<div class="none">${r.outOfStock && r.outOfStock.length
        ? "Every match nearby is out of stock right now."
        : "No matches found nearby. Try a simpler word."}</div>`;
      html += optionList(r.outOfStock || [], "out of stock", storeName);
      html += `</article>`;
      continue;
    }
    html += dealHTML(r.best, storeName(r.best.storeId));

    // Other sale items for this search that aren't the best deal
    const otherDeals = (r.deals || []).filter((d) => d !== r.best && !(d.name === r.best.name && d.storeId === r.best.storeId));
    if (otherDeals.length) {
      html += `<div class="more-deals"><b>Also on sale:</b> ${otherDeals
        .map((d) => `${esc(d.name)} at ${esc(storeName(d.storeId))}, ${money(d.price)} <span class="unit">(save ${money(d.savings)})</span>`)
        .join(" · ")}</div>`;
    }
    html += optionList(r.others, "more option", storeName);
    html += optionList(r.outOfStock || [], "out of stock", storeName);
    html += `</article>`;
  }
  html += `<p class="unit">${data.usedAI ? "Your list was read by AI. " : ""}Prices are checked live but can change. Confirm at the store.</p>`;
  out.innerHTML = html;
  out.scrollIntoView({ behavior: "smooth", block: "start" });
}

// A collapsible list of extra options ("5 more options", "2 out of stock").
function optionList(list, label, storeName) {
  if (!list.length) return "";
  const title = label === "out of stock"
    ? `${list.length} out of stock`
    : `${list.length} ${label}${list.length > 1 ? "s" : ""}`;
  let html = `<details class="others"><summary>${title}</summary><ul>`;
  for (const o of list) {
    html += `<li><span>${esc(o.name)} ${o.size ? `· ${esc(o.size)}` : ""}<br>
        <span class="unit">${esc(storeName(o.storeId))}${o.aisle ? ` · ${esc(o.aisle)}` : ""}</span> ${stockBadge(o.stockLevel)}</span>
      <span class="opt-price">${o.salePrice ? `<span class="was">${money(o.regularPrice)}</span>` : ""}<b>${money(o.price)}</b>
        ${o.unitPrice ? `<br><span class="unit">${unitText(o)}</span>` : ""}</span></li>`;
  }
  return html + `</ul></details>`;
}

// Kroger stock levels -> friendly labels
function stockBadge(level) {
  if (level === "HIGH") return '<span class="badge stock-ok">In stock</span>';
  if (level === "LOW") return '<span class="badge stock-low">Low stock</span>';
  if (level === "TEMPORARILY_OUT_OF_STOCK") return '<span class="badge stock-out">Out of stock</span>';
  return '<span class="badge stock-unknown">Stock unknown</span>';
}

function unitText(p) {
  const unit = p.unit === "each" ? "each" : p.unit;
  const value = p.unitPrice < 1 ? `${(p.unitPrice * 100).toFixed(1)}¢` : money(p.unitPrice);
  return `${value} / ${unit}`;
}

function dealHTML(p, store) {
  const img = p.image
    ? `<img src="${esc(p.image)}" alt="" loading="lazy">`
    : `<div class="ph">$</div>`;
  const name = p.url
    ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.name)}</a>`
    : esc(p.name);
  return `<div class="deal">
    ${img}
    <div class="deal-info">
      <span class="badge best">Best deal</span>
      ${p.salePrice ? `<span class="badge sale">On sale: save ${money(p.savings)}</span>` : ""}
      ${stockBadge(p.stockLevel)}
      <div class="deal-name">${name}</div>
      <div class="deal-meta">${esc(store)}${p.size ? ` · ${esc(p.size)}` : ""}${p.aisle ? ` · ${esc(p.aisle)}` : ""}</div>
      <div class="deal-meta small">${[p.pickup ? "✓ Pickup" : "", p.delivery ? "✓ Delivery" : ""].filter(Boolean).join("  ")}</div>
    </div>
    <div class="deal-price">
      ${p.salePrice ? `<span class="was">${money(p.regularPrice)}</span>` : ""}<span class="price">${money(p.price)}</span>
      ${p.unitPrice ? `<div class="unit">${unitText(p)}</div>` : ""}
    </div>
  </div>`;
}
