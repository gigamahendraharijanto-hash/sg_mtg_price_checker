const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");

const stores = [
  {
    id: "hideout",
    name: "Hideout",
    baseUrl: "https://hideoutcg.com",
    adapter: "shopify",
    shipping: {
      name: "Registered Mail (Singles)",
      price: 4,
      source: "shopify-shipping-rates",
    },
  },
  {
    id: "games-haven",
    name: "Games Haven",
    baseUrl: "https://www.gameshaventcg.com",
    adapter: "shopify",
    shipping: {
      name: "Regular Mail",
      price: 2.5,
      source: "shopify-shipping-rates",
    },
  },
  {
    id: "mtg-asia",
    name: "MTG Asia",
    baseUrl: "https://www.mtg-asia.com",
    adapter: "shopify",
    shipping: {
      name: "Regular tracked mail",
      price: 2.5,
      minSubtotal: 15,
      source: "published-faq-fallback",
    },
  },
  {
    id: "grey-ogre",
    name: "Grey Ogre",
    baseUrl: "https://www.greyogregames.com",
    adapter: "shopify",
    shipping: {
      name: "Standard Package",
      price: 3,
      source: "shopify-shipping-rates",
    },
  },
  {
    id: "one-mtg",
    name: "One MTG",
    baseUrl: "https://onemtg.com.sg",
    adapter: "shopify",
    shipping: {
      name: "Tracked Shipping",
      price: 3,
      source: "shopify-shipping-rates",
    },
  },
];

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const scryfallAliasCache = new Map();
const responseCache = new Map();
const requestQueues = new Map();
const HOSTED_MODE = Boolean(process.env.RENDER || process.env.NODE_ENV === "production");
const REQUEST_CACHE_TTL_MS = 10 * 60 * 1000;
const REQUEST_GAP_MS = HOSTED_MODE ? 1200 : 250;
const RETRY_429_MS = HOSTED_MODE ? 8000 : 2500;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cacheKeyFor(url, options = {}) {
  return `${String(options.method || "GET").toUpperCase()} ${String(url)}`;
}

function cachedResponse(url, options) {
  const key = cacheKeyFor(url, options);
  const cached = responseCache.get(key);
  if (!cached || cached.expiresAt <= Date.now()) {
    responseCache.delete(key);
    return null;
  }
  return new Response(cached.body, {
    status: cached.status,
    statusText: cached.statusText,
    headers: cached.headers,
  });
}

async function rememberResponse(url, options, response) {
  if (!response.ok || String(options.method || "GET").toUpperCase() !== "GET") return;
  const key = cacheKeyFor(url, options);
  const headers = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  responseCache.set(key, {
    body: await response.clone().text(),
    status: response.status,
    statusText: response.statusText,
    headers,
    expiresAt: Date.now() + REQUEST_CACHE_TTL_MS,
  });
}

async function politeFetch(url, options = {}) {
  const target = new URL(String(url));
  const cached = cachedResponse(target, options);
  if (cached) return cached;

  const queueKey = target.hostname;
  const previous = requestQueues.get(queueKey) || Promise.resolve();
  let release;
  const current = previous.catch(() => {}).then(() => new Promise((resolve) => {
    release = resolve;
  }));
  requestQueues.set(queueKey, current);
  await previous.catch(() => {});

  try {
    await delay(REQUEST_GAP_MS);
    const headers = {
      "accept": "*/*",
      "user-agent": "Mozilla/5.0 (compatible; SGMTGPriceFinder/0.1; personal deck price comparison)",
      ...(options.headers || {}),
    };
    let response = await fetch(target, { ...options, headers });

    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after") || 0);
      await delay(retryAfter ? retryAfter * 1000 : RETRY_429_MS);
      response = await fetch(target, { ...options, headers });
    }

    await rememberResponse(target, options, response);
    return response;
  } finally {
    release();
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function stripTags(html = "") {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(value = "") {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function fieldFromBody(body, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = body.match(new RegExp(`<td>\\s*${escaped}:\\s*<\\/td>\\s*<td>(.*?)<\\/td>`, "i"));
  return match ? decodeHtml(stripTags(match[1])) : "";
}

function parseDecklist(input) {
  const cards = new Map();
  const lines = String(input || "").split(/\r?\n/);

  for (const rawLine of lines) {
    let line = rawLine
      .replace(/\/\/.*$/, "")
      .replace(/#.*$/, "")
      .trim();

    if (!line || /^(deck|sideboard|commander|maybeboard)$/i.test(line)) continue;
    line = line.replace(/^SB:\s*/i, "");
    line = line.replace(/\s+\([A-Z0-9]{2,6}\)\s+\d+[a-z]?$/i, "");
    line = line.replace(/\s+\[[^\]]+\]$/i, "");

    const match = line.match(/^(\d+)x?\s+(.+)$/i);
    const quantity = match ? Number(match[1]) : 1;
    const name = foldText(match ? match[2] : line).trim();
    if (!name) continue;

    const key = normalizeName(name);
    const existing = cards.get(key);
    if (existing) {
      existing.quantity += quantity;
    } else {
      cards.set(key, { name, quantity });
    }
  }

  return [...cards.values()];
}

function foldText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’‘`´]/g, "'")
    .replace(/[“”]/g, "\"")
    .replace(/[–—]/g, "-");
}

function normalizeName(value) {
  return foldText(value)
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function playableNameMatches(productName, query) {
  const name = normalizeName(productName);
  const wanted = normalizeName(query);
  return name === wanted || name.startsWith(`${wanted} (`) || name.startsWith(`${wanted} [`);
}

function limitedStock(value) {
  const stock = Number(value);
  return Number.isFinite(stock) && stock > 0 ? Math.floor(stock) : null;
}

function quantityForCart(requested, maxQuantity) {
  const wanted = Math.max(Number(requested || 1), 1);
  return maxQuantity ? Math.min(wanted, maxQuantity) : wanted;
}

function buildShopifyCartUrl(store, variantId, quantity) {
  if (!variantId) return "";
  const safeQuantity = Math.max(Number(quantity || 1), 1);
  return new URL(`/cart/${variantId}:${safeQuantity}`, store.baseUrl).toString();
}

function cartUrlForQuantity(item, quantity) {
  const store = stores.find((entry) => entry.id === item.storeId);
  if (store?.adapter === "shopify" && item.variantId) {
    return buildShopifyCartUrl(store, item.variantId, quantity);
  }
  return item.cartUrl || item.url;
}

function batchCartUrlForItems(storeId, items) {
  const store = stores.find((entry) => entry.id === storeId);
  if (!store || store.adapter !== "shopify") return items[0]?.url || store?.baseUrl || "";
  const cartLines = items
    .filter((item) => item.variantId)
    .map((item) => `${item.variantId}:${Math.max(Number(item.quantity || 1), 1)}`);
  if (!cartLines.length) return new URL("/cart", store.baseUrl).toString();
  return new URL(`/cart/${cartLines.join(",")}`, store.baseUrl).toString();
}

function deliveryEstimateForStore(storeId, subtotal) {
  const store = stores.find((entry) => entry.id === storeId);
  const shipping = store?.shipping;
  if (!shipping) {
    return {
      name: "Delivery unavailable",
      price: 0,
      eligible: false,
      source: "missing",
    };
  }

  if (shipping.minSubtotal && subtotal < shipping.minSubtotal) {
    return {
      ...shipping,
      eligible: false,
      shortfall: shipping.minSubtotal - subtotal,
    };
  }

  return {
    ...shipping,
    eligible: true,
  };
}

function cartSupport(store, variantId) {
  if (store.adapter === "shopify" && variantId) return "direct";
  return "listing";
}

function artKeyFor(item) {
  return normalizeName(`${item.image || item.title} ${item.set || ""}`);
}

function embeddedInventoryFromHtml(html, variantId) {
  if (!variantId) return null;
  const content = String(html || "");
  const inventoryPattern = new RegExp(`"${variantId}"\\s*:\\s*\\{[\\s\\S]*?"inventory_quantity"\\s*:\\s*(-?\\d+)`, "i");
  const inventoryMatch = content.match(inventoryPattern);
  if (inventoryMatch) return limitedStock(inventoryMatch[1]);

  const optionPattern = new RegExp(`<option[^>]*value=["']${variantId}["'][^>]*data-stock=["'](-?\\d+)["']`, "i");
  const optionMatch = content.match(optionPattern);
  if (optionMatch) return limitedStock(optionMatch[1]);

  return null;
}

async function fetchEmbeddedShopifyStock(store, handle, variantId) {
  if (!handle || !variantId) return null;
  try {
    const response = await politeFetch(new URL(`/products/${handle}`, store.baseUrl), {
      headers: { "user-agent": "SG MTG Price Finder/0.1 (+local personal price comparison)" },
    });
    if (!response.ok) return null;
    return embeddedInventoryFromHtml(await response.text(), variantId);
  } catch {
    return null;
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function moxfieldDeckId(value) {
  const match = String(value || "").match(/moxfield\.com\/decks\/([A-Za-z0-9_-]+)/i);
  return match ? match[1] : "";
}

function deckTextFromMoxfieldDeck(deck) {
  const zones = [deck.commanders, deck.mainboard];
  const lines = [];
  for (const zone of zones) {
    for (const entry of Object.values(zone || {})) {
      const name = entry.card?.name || entry.card?.faceName || "";
      const quantity = Number(entry.quantity || 1);
      if (name) lines.push(`${quantity} ${name}`);
    }
  }
  return lines.join("\n");
}

async function fetchMoxfieldDeck(deckId) {
  const response = await politeFetch(`https://api2.moxfield.com/v2/decks/all/${deckId}`, {
    headers: {
      "accept": "application/json",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:115.0) Gecko/20100101 Firefox/115.0 SGMTGPriceFinder/0.1",
    },
  });

  if (!response.ok) {
    throw new Error(`Moxfield blocked or rejected the deck request (${response.status}). Use Moxfield's export/copy decklist option and paste the list here.`);
  }

  const deck = await response.json();
  return {
    name: deck.name || "Moxfield deck",
    decklist: deckTextFromMoxfieldDeck(deck),
  };
}

async function handleMoxfield(req, res, url) {
  let source = url.searchParams.get("url") || "";
  if (req.method === "POST") {
    const body = await readBody(req);
    try {
      const parsed = JSON.parse(body || "{}");
      source = parsed.url || parsed.deck || source;
    } catch {
      source = body || source;
    }
  }

  const deckId = moxfieldDeckId(source);
  if (!deckId) {
    sendJson(res, 400, { error: "Enter a valid Moxfield deck URL." });
    return;
  }

  const deck = await fetchMoxfieldDeck(deckId);
  sendJson(res, 200, deck);
}

async function normalizeShopifyProduct(product, store, query) {
  const priceMin = Number(product.price_min ?? product.price ?? 0);
  const priceMax = Number(product.price_max ?? product.price ?? 0);
  const title = decodeHtml(product.title || "Untitled card");
  const setFromTitle = title.match(/\[([^\]]+)\]\s*$/);
  const set = fieldFromBody(product.body || "", "Set") || (setFromTitle ? setFromTitle[1] : "");
  const cardName = title.replace(/\s*\[[^\]]+\]\s*$/, "");
  const url = new URL(product.url || `/products/${product.handle || ""}`, store.baseUrl).toString();
  if (!playableNameMatches(cardName, query)) return null;

  let cheapestVariant = null;
  try {
    const productUrl = new URL(`/products/${product.handle}.js`, store.baseUrl);
    const response = await politeFetch(productUrl, { headers: { "accept": "application/json" } });
    if (response.ok) {
      const detail = await response.json();
      cheapestVariant = (detail.variants || [])
        .filter((variant) => variant.available)
        .map((variant) => ({
          id: variant.id,
          title: variant.public_title || variant.title || "",
          price: Number(variant.price || 0) / 100,
          stock: limitedStock(variant.inventory_quantity),
        }))
        .sort((a, b) => a.price - b.price)[0] || null;
    }
  } catch {
    cheapestVariant = null;
  }

  const available = Boolean(cheapestVariant || product.available);
  if (!available) return null;
  const cheapestPrice = cheapestVariant ? cheapestVariant.price : priceMin;

  return {
    id: `${store.id}:${product.id || product.handle || title}`,
    store: store.name,
    storeId: store.id,
    title,
    cardName,
    set,
    type: product.type || "",
    rarity: fieldFromBody(product.body || "", "Rarity"),
    available,
    priceMin: cheapestPrice,
    priceMax: cheapestPrice,
    priceLabel: `$${cheapestPrice.toFixed(2)} SGD`,
    condition: cheapestVariant?.title || "",
    variantId: cheapestVariant?.id || "",
    maxQuantity: cheapestVariant?.stock || null,
    handle: product.handle || "",
    cartSupport: cartSupport(store, cheapestVariant?.id),
    cartUrl: buildShopifyCartUrl(store, cheapestVariant?.id, 1) || url,
    image: product.featured_image?.url || product.image || "",
    url,
    tags: Array.isArray(product.tags) ? product.tags : [],
  };
}

async function searchShopifyStore(store, query, limit) {
  const url = new URL("/search/suggest.json", store.baseUrl);
  url.searchParams.set("q", query);
  url.searchParams.set("resources[type]", "product");
  url.searchParams.set("resources[limit]", String(limit));

  const response = await politeFetch(url, {
    headers: {
      "accept": "application/json",
      "user-agent": "SG MTG Price Finder/0.1 (+local personal price comparison)",
    },
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const products = data?.resources?.results?.products || [];
  const normalized = [];
  for (const product of products) {
    const item = await normalizeShopifyProduct(product, store, query);
    if (item) normalized.push(item);
  }
  return normalized.filter(Boolean);
}

async function scryfallAliasesForCard(name) {
  const key = normalizeName(name);
  if (scryfallAliasCache.has(key)) return scryfallAliasCache.get(key);

  const aliases = new Set([name]);
  try {
    const namedUrl = new URL("https://api.scryfall.com/cards/named");
    namedUrl.searchParams.set("exact", name);
    const namedResponse = await politeFetch(namedUrl, {
      headers: { "accept": "application/json", "user-agent": "SGMTGPriceFinder/0.1 (local deck budget builder)" },
    });
    if (!namedResponse.ok) throw new Error("Scryfall named lookup failed");
    const named = await namedResponse.json();
    if (named.flavor_name) aliases.add(named.flavor_name);
    if (named.printed_name) aliases.add(named.printed_name);

    let searchUrl = new URL("https://api.scryfall.com/cards/search");
    searchUrl.searchParams.set("q", `oracleid:${named.oracle_id}`);
    searchUrl.searchParams.set("unique", "prints");
    for (let page = 0; page < 4 && searchUrl; page += 1) {
      const response = await politeFetch(searchUrl, {
        headers: { "accept": "application/json", "user-agent": "SGMTGPriceFinder/0.1 (local deck budget builder)" },
      });
      if (!response.ok) break;
      const data = await response.json();
      for (const card of data.data || []) {
        if (card.flavor_name) aliases.add(card.flavor_name);
        if (card.printed_name) aliases.add(card.printed_name);
      }
      searchUrl = data.has_more && data.next_page ? new URL(data.next_page) : null;
    }
  } catch {
    // Alias lookup is a quality boost; normal card-name search remains the fallback.
  }

  const result = [...aliases].map(foldText).filter(Boolean);
  scryfallAliasCache.set(key, result);
  return result;
}

async function searchStoreWithAliases(store, cardName, aliases, limit) {
  const byId = new Map();
  for (const alias of aliases) {
    const results = await searchStore(store, alias, limit);
    for (const item of results) byId.set(item.id, item);
  }
  return [...byId.values()];
}

async function searchMoxStore(store, query) {
  const url = new URL("/api/products", store.baseUrl);
  url.searchParams.set("search", query);
  const response = await politeFetch(url, { headers: { "accept": "application/json" } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const products = await response.json();

  return (Array.isArray(products) ? products : [])
    .filter((product) => playableNameMatches(product.title, query))
    .map((product) => {
      const cheapest = (product.conditions || [])
        .filter((condition) => Number(condition.stocks || 0) > 0 && Number(condition.price || 0) > 0)
        .map((condition) => ({
          title: condition.code || "",
          price: Number(condition.price || 0),
          stock: Number(condition.stocks || 0),
        }))
        .sort((a, b) => a.price - b.price)[0];

      if (!cheapest) return null;
      return {
        id: `${store.id}:${product.id}`,
        store: store.name,
        storeId: store.id,
        title: product.title,
        cardName: product.title,
        set: product.expansion || product.ck_edition || "",
        type: product.type_code || "",
        rarity: product.rarity || product.rarity_code || "",
        available: true,
        priceMin: cheapest.price,
        priceMax: cheapest.price,
        priceLabel: `$${cheapest.price.toFixed(2)} SGD`,
        condition: cheapest.title,
        stock: cheapest.stock,
        maxQuantity: cheapest.stock,
        cartSupport: cartSupport(store),
        cartUrl: new URL(`/products/${product.id}`, store.baseUrl).toString(),
        image: product.image_path || "",
        url: new URL(`/products/${product.id}`, store.baseUrl).toString(),
        tags: [],
      };
    })
    .filter(Boolean);
}

function attr(fragment, name) {
  const match = fragment.match(new RegExp(`${name}=["']([^"']+)["']`, "i"));
  return match ? decodeHtml(match[1]) : "";
}

async function searchDuellersStore(store, query) {
  const url = new URL("/products/search", store.baseUrl);
  url.searchParams.set("search_text", query);
  const response = await politeFetch(url, { headers: { "accept": "text/html" } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const html = await response.text();
  const rows = html.match(/<tr>[\s\S]*?<\/tr>/gi) || [];

  return rows.map((row) => {
    const nameLink = row.match(/<a[^>]+class=["'][^"']*fw-bold[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!nameLink) return null;
    const cardName = stripTags(nameLink[2]);
    if (!playableNameMatches(cardName, query)) return null;
    if (/Out of Stock/i.test(row)) return null;
    const priceMatch = row.match(/S\$\s*([0-9]+(?:\.[0-9]+)?)/i);
    if (!priceMatch) return null;
    const editionMatch = row.match(/<strong>([^<]+)<\/strong>/i);
    const imgMatch = row.match(/<img[^>]+>/i);

    return {
      id: `${store.id}:${nameLink[1]}`,
      store: store.name,
      storeId: store.id,
      title: cardName,
      cardName,
      set: editionMatch ? decodeHtml(editionMatch[1]) : "",
      type: "",
      rarity: "",
      available: true,
      priceMin: Number(priceMatch[1]),
      priceMax: Number(priceMatch[1]),
      priceLabel: `$${Number(priceMatch[1]).toFixed(2)} SGD`,
      condition: "",
      maxQuantity: null,
      cartSupport: cartSupport(store),
      cartUrl: new URL(nameLink[1], store.baseUrl).toString(),
      image: imgMatch ? new URL(attr(imgMatch[0], "src"), store.baseUrl).toString() : "",
      url: new URL(nameLink[1], store.baseUrl).toString(),
      tags: [],
    };
  }).filter(Boolean);
}

async function searchStore(store, query, limit) {
  if (store.adapter === "mox") return searchMoxStore(store, query, limit);
  if (store.adapter === "duellers") return searchDuellersStore(store, query, limit);
  return searchShopifyStore(store, query, limit);
}

async function enrichStockForListing(item) {
  const store = stores.find((entry) => entry.id === item.storeId);
  if (!store || store.adapter !== "shopify" || item.maxQuantity || !item.variantId) return;
  const handle = item.handle || item.url.match(/\/products\/([^/?#]+)/)?.[1] || "";
  const stock = await fetchEmbeddedShopifyStock(store, handle, item.variantId);
  if (stock) item.maxQuantity = stock;
}

async function enrichStockForListings(items) {
  const seen = new Set();
  for (const item of items) {
    if (!item || item.missing) continue;
    const key = `${item.storeId}:${item.variantId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await enrichStockForListing(item);
  }
}

function cheapestByStore(results) {
  const byStore = new Map();
  for (const result of results) {
    const current = byStore.get(result.storeId);
    if (!current || result.priceMin < current.priceMin) byStore.set(result.storeId, result);
  }
  return stores.map((store) => byStore.get(store.id) || {
    store: store.name,
    storeId: store.id,
    missing: true,
  });
}

function cheapestArtOptions(results, limit = 8) {
  const byArt = new Map();
  for (const result of results) {
    const key = artKeyFor(result);
    const current = byArt.get(key);
    if (!current || result.priceMin < current.priceMin) byArt.set(key, result);
  }

  return [...byArt.values()]
    .sort((a, b) => a.priceMin - b.priceMin || a.store.localeCompare(b.store) || a.title.localeCompare(b.title))
    .slice(0, limit);
}

async function handleSearch(req, res, url) {
  let query = (url.searchParams.get("q") || "").trim();
  if (req.method === "POST") {
    const body = await readBody(req);
    try {
      const parsed = JSON.parse(body || "{}");
      query = String(parsed.q || parsed.decklist || query).trim();
    } catch {
      query = body.trim();
    }
  }
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 10), 1), 20);

  if (!query) {
    sendJson(res, 400, { error: "Enter a card name to search." });
    return;
  }

  const cards = parseDecklist(query);
  const errors = [];
  const cardResults = [];

  for (const card of cards) {
    const aliases = await scryfallAliasesForCard(card.name);
    const results = [];
    for (const store of stores) {
      try {
        results.push(...await searchStoreWithAliases(store, card.name, aliases, limit));
      } catch (error) {
        errors.push({ card: card.name, store: store.name, message: error?.message || "Search failed" });
      }
    }
    results.sort((a, b) => a.priceMin - b.priceMin || a.store.localeCompare(b.store) || a.title.localeCompare(b.title));
    const storesForCard = cheapestByStore(results);
    await enrichStockForListings(storesForCard.filter((item) => !item.missing));
    const printings = cheapestArtOptions(results);
    const bestOverall = storesForCard
      .filter((item) => !item.missing)
      .sort((a, b) => a.priceMin - b.priceMin || a.store.localeCompare(b.store))[0] || null;
    const selectedQuantity = bestOverall ? quantityForCart(card.quantity, bestOverall.maxQuantity) : 0;
    cardResults.push({
      ...card,
      requestedQuantity: card.quantity,
      selectedQuantity,
      stores: storesForCard,
      printings,
      listings: results.slice(0, 30),
      bestOverall,
      bestTotal: bestOverall ? bestOverall.priceMin * selectedQuantity : null,
    });
  }

  const checkoutPlan = buildCheckoutPlan(cardResults);
  const deliveredPlan = buildDeliveredPlan(cardResults);

  sendJson(res, 200, {
    query,
    cards,
    searchedAt: new Date().toISOString(),
    stores: stores.map(({ id, name, baseUrl, shipping }) => ({ id, name, baseUrl, shipping })),
    errors,
    cardResults,
    checkoutPlan,
    deliveredPlan,
    results: cardResults.flatMap((card) => card.stores.filter((store) => !store.missing)),
  });
}

function buildCheckoutPlan(cardResults) {
  const byStore = new Map();
  const missing = [];

  for (const card of cardResults) {
    if (!card.bestOverall) {
      missing.push({ name: card.name, quantity: card.quantity });
      continue;
    }

    const quantity = quantityForCart(card.quantity, card.bestOverall.maxQuantity);
    if (quantity < card.quantity) {
      missing.push({
        name: card.name,
        quantity: card.quantity - quantity,
        reason: `Only ${quantity} available from ${card.bestOverall.store}`,
      });
    }

    const key = card.bestOverall.storeId;
    if (!byStore.has(key)) {
      byStore.set(key, {
        store: card.bestOverall.store,
        storeId: card.bestOverall.storeId,
        items: [],
        total: 0,
        delivery: null,
        deliveredTotal: null,
        cartUrl: "",
      });
    }

    const group = byStore.get(key);
    const lineTotal = card.bestOverall.priceMin * quantity;
    group.total += lineTotal;
    group.items.push({
      id: card.bestOverall.id,
      name: card.name,
      requestedQuantity: card.quantity,
      quantity,
      maxQuantity: card.bestOverall.maxQuantity,
      unitPrice: card.bestOverall.priceMin,
      lineTotal,
      title: card.bestOverall.title,
      condition: card.bestOverall.condition || "",
      set: card.bestOverall.set || "",
      image: card.bestOverall.image || "",
      url: card.bestOverall.url,
      cartUrl: cartUrlForQuantity(card.bestOverall, quantity),
      cartSupport: card.bestOverall.cartSupport || "listing",
      variantId: card.bestOverall.variantId || "",
    });
  }

  const groups = [...byStore.values()].sort((a, b) => b.total - a.total || a.store.localeCompare(b.store));
  for (const group of groups) {
    group.delivery = deliveryEstimateForStore(group.storeId, group.total);
    group.deliveredTotal = group.delivery.eligible ? group.total + group.delivery.price : null;
    group.cartUrl = batchCartUrlForItems(group.storeId, group.items);
  }
  const deliveryTotal = groups.reduce((sum, group) => sum + (group.delivery?.eligible ? group.delivery.price : 0), 0);
  return {
    groups,
    missing,
    total: groups.reduce((sum, group) => sum + group.total, 0),
    deliveryTotal,
    deliveredTotal: groups.reduce((sum, group) => sum + group.total, 0) + deliveryTotal,
  };
}

function groupPlanItems(items) {
  const byStore = new Map();
  for (const item of items) {
    if (!byStore.has(item.storeId)) {
      byStore.set(item.storeId, {
        store: item.store,
        storeId: item.storeId,
        items: [],
        total: 0,
        delivery: null,
        deliveredTotal: null,
        cartUrl: "",
      });
    }

    const group = byStore.get(item.storeId);
    group.total += item.lineTotal;
    group.items.push(item);
  }

  const groups = [...byStore.values()].sort((a, b) => b.total - a.total || a.store.localeCompare(b.store));
  for (const group of groups) {
    group.delivery = deliveryEstimateForStore(group.storeId, group.total);
    group.deliveredTotal = group.delivery.eligible ? group.total + group.delivery.price : null;
    group.cartUrl = batchCartUrlForItems(group.storeId, group.items);
  }

  return groups;
}

function planTotals(groups) {
  const subtotal = groups.reduce((sum, group) => sum + group.total, 0);
  const deliveryTotal = groups.reduce((sum, group) => sum + (group.delivery?.eligible ? group.delivery.price : 0), 0);
  return {
    total: subtotal,
    deliveryTotal,
    deliveredTotal: subtotal + deliveryTotal,
  };
}

function planItemFromListing(card, listing) {
  const quantity = quantityForCart(card.quantity, listing.maxQuantity);
  const lineTotal = listing.priceMin * quantity;
  return {
    id: listing.id,
    name: card.name,
    requestedQuantity: card.quantity,
    quantity,
    maxQuantity: listing.maxQuantity,
    unitPrice: listing.priceMin,
    lineTotal,
    title: listing.title,
    condition: listing.condition || "",
    set: listing.set || "",
    image: listing.image || "",
    url: listing.url,
    cartUrl: cartUrlForQuantity(listing, quantity),
    cartSupport: listing.cartSupport || "listing",
    variantId: listing.variantId || "",
    store: listing.store,
    storeId: listing.storeId,
  };
}

function buildDeliveredPlan(cardResults) {
  const storeIds = stores.map((store) => store.id);
  let bestPlan = null;
  const missing = [];

  for (let mask = 1; mask < (1 << storeIds.length); mask += 1) {
    const allowed = new Set(storeIds.filter((_, index) => mask & (1 << index)));
    const items = [];
    let feasible = true;

    for (const card of cardResults) {
      const listing = (card.listings || [])
        .filter((item) => allowed.has(item.storeId))
        .filter((item) => !item.maxQuantity || item.maxQuantity >= card.quantity)
        .sort((a, b) => a.priceMin - b.priceMin || a.store.localeCompare(b.store) || a.title.localeCompare(b.title))[0];

      if (!listing) {
        feasible = false;
        break;
      }

      items.push(planItemFromListing(card, listing));
    }

    if (!feasible) continue;
    const groups = groupPlanItems(items);
    if (groups.some((group) => !group.delivery?.eligible)) continue;
    const totals = planTotals(groups);
    const candidate = { groups, missing: [], ...totals, mode: "delivered" };

    if (!bestPlan || candidate.deliveredTotal < bestPlan.deliveredTotal) {
      bestPlan = candidate;
    }
  }

  if (bestPlan) return bestPlan;

  for (const card of cardResults) {
    if (!card.bestOverall) missing.push({ name: card.name, quantity: card.quantity });
  }

  return {
    groups: [],
    missing,
    total: 0,
    deliveryTotal: 0,
    deliveredTotal: 0,
    mode: "delivered",
  };
}

async function serveStatic(req, res, url) {
  const requestedPath = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  const filePath = path.resolve(PUBLIC_DIR, requestedPath);

  if (!filePath.startsWith(path.resolve(PUBLIC_DIR) + path.sep)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const file = await fs.readFile(filePath);
    res.writeHead(200, {
      "content-type": contentTypes[path.extname(filePath)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(file);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (url.pathname === "/health") {
      let publicFiles = [];
      try {
        publicFiles = await fs.readdir(PUBLIC_DIR);
      } catch {
        publicFiles = [];
      }
      sendJson(res, 200, {
        ok: true,
        publicDir: PUBLIC_DIR,
        publicFiles,
      });
      return;
    }

    if (url.pathname === "/api/search") {
      await handleSearch(req, res, url);
      return;
    }

    if (url.pathname === "/api/moxfield") {
      await handleMoxfield(req, res, url);
      return;
    }

    if (url.pathname === "/api/stores") {
      sendJson(res, 200, { stores });
      return;
    }

    await serveStatic(req, res, url);
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Unexpected server error" });
  }
});

server.listen(PORT, () => {
  console.log(`SG MTG Price Finder running at http://localhost:${PORT}`);
});
