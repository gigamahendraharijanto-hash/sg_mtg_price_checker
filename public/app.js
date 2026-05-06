const form = document.querySelector("#search-form");
const input = document.querySelector("#card-input");
const inputLabel = document.querySelector("#input-label");
const modeButtons = document.querySelectorAll(".mode-button");
const statusEl = document.querySelector("#status");
const progressPanelEl = document.querySelector("#progress-panel");
const progressTitleEl = document.querySelector("#progress-title");
const progressCountEl = document.querySelector("#progress-count");
const progressFillEl = document.querySelector("#progress-fill");
const progressListEl = document.querySelector("#progress-list");
const summaryEl = document.querySelector("#summary");
const checkoutPlanEl = document.querySelector("#checkout-plan");
const resultsEl = document.querySelector("#results");
const submitButton = form.querySelector("button[type='submit']");
const cancelButton = document.querySelector("#cancel-search");

let mode = "batch";
let progressTimer = null;
let currentData = null;
let cartItems = [];
let activeSearchController = null;
let searchCancelled = false;
const carouselPositions = new Map();
const collapsedCards = new Map();
let panelsCollapseByDefault = false;

function foldText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’‘`´]/g, "'")
    .replace(/[“”]/g, "\"")
    .replace(/[–—]/g, "-");
}

function money(value) {
  return new Intl.NumberFormat("en-SG", {
    style: "currency",
    currency: "SGD",
  }).format(value || 0);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeKey(value) {
  return foldText(value).toLowerCase().replace(/\s+/g, " ").trim();
}

function idKey(value) {
  return normalizeKey(value).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "card";
}

function parseInputCards(value) {
  const cards = new Map();
  String(value || "").split(/\r?\n/).forEach((rawLine) => {
    let line = rawLine
      .replace(/\/\/.*$/, "")
      .replace(/#.*$/, "")
      .trim();

    if (!line || /^(deck|sideboard|commander|maybeboard)$/i.test(line)) return;
    line = line.replace(/^SB:\s*/i, "");
    line = line.replace(/\s+\([A-Z0-9]{2,6}\)\s+\d+[a-z]?$/i, "");
    line = line.replace(/\s+\[[^\]]+\]$/i, "");

    const match = line.match(/^(\d+)x?\s+(.+)$/i);
    const quantity = match ? Number(match[1]) : 1;
    const name = foldText(match ? match[2] : line).trim();
    if (!name) return;

    const key = normalizeKey(name);
    const existing = cards.get(key);
    if (existing) existing.quantity += quantity;
    else cards.set(key, { name, quantity });
  });
  return [...cards.values()];
}

function isMoxfieldUrl(value) {
  return /moxfield\.com\/decks\/[A-Za-z0-9_-]+/i.test(String(value || ""));
}

async function importMoxfieldDeck(url, signal) {
  const response = await fetch("/api/moxfield", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
    signal,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Could not import Moxfield deck.");
  if (!data.decklist) throw new Error("Moxfield deck did not return a decklist.");
  input.value = data.decklist;
  statusEl.textContent = `Imported ${data.name || "Moxfield deck"}. Searching stores...`;
  return data.decklist;
}

function clampQuantity(value, maxQuantity) {
  const quantity = Math.max(Number(value || 1), 1);
  return maxQuantity ? Math.min(quantity, maxQuantity) : quantity;
}

function activeStoreCount() {
  return currentData?.stores?.length || 5;
}

function searchingStoresText() {
  return `Searching ${activeStoreCount()} stores...`;
}

function setSearchingState(active) {
  submitButton.disabled = active;
  cancelButton.hidden = !active;
  cancelButton.disabled = !active;
}

function startProgress(cards) {
  stopProgress();
  const total = Math.max(cards.length, 1);

  progressPanelEl.hidden = false;
  progressTitleEl.textContent = "Checking stores";
  progressCountEl.textContent = `0 / ${total}`;
  progressFillEl.style.width = "0%";
  progressListEl.innerHTML = cards.map((card, cardIndex) => `
    <div class="progress-card ${cardIndex === 0 ? "current" : ""}" data-progress-card="${cardIndex}">
      <div class="progress-card-name">${escapeHtml(card.quantity)}x ${escapeHtml(card.name)}</div>
      <div class="progress-card-detail">${cardIndex === 0 ? searchingStoresText() : "Waiting"}</div>
    </div>
  `).join("");
}

function updateProgress(done, total) {
  progressCountEl.textContent = `${done} / ${total}`;
  progressFillEl.style.width = `${Math.round((done / Math.max(total, 1)) * 100)}%`;
}

function setProgressCard(cardIndex, state, message) {
  const card = progressListEl.querySelector(`[data-progress-card="${cardIndex}"]`);
  if (!card) return;
  card.classList.remove("current", "done", "error");
  card.classList.add(state);
  card.querySelector(".progress-card-detail").textContent = message;
}

function finishProgress(success, message) {
  stopProgress();
  progressPanelEl.hidden = false;
  progressTitleEl.textContent = success ? "Finished checking stores" : "Search stopped";
  progressFillEl.style.width = "100%";
  progressCountEl.textContent = success ? "Done" : "Error";

  progressListEl.querySelectorAll(".progress-card").forEach((card) => {
    card.classList.remove("current");
    card.classList.add(success ? "done" : "error");
    card.querySelector(".progress-card-detail").textContent = message || (success ? "Done" : "Failed");
  });
}

function stopProgress() {
  if (progressTimer) {
    clearInterval(progressTimer);
    progressTimer = null;
  }
}

function resultById(id) {
  return (currentData?.cardResults || [])
    .flatMap((card) => card.listings || [])
    .find((item) => item.id === id);
}

function storeBaseUrl(storeId) {
  return (currentData?.stores || []).find((store) => store.id === storeId)?.baseUrl || "";
}

function storeById(storeId) {
  return (currentData?.stores || []).find((store) => store.id === storeId) || null;
}

function cartUrlForItem(item) {
  if (item.cartSupport === "direct" && item.variantId) {
    const baseUrl = storeBaseUrl(item.storeId);
    if (baseUrl) return `${baseUrl}/cart/${item.variantId}:${item.quantity}`;
  }
  return item.cartUrl || item.url;
}

function cartUrlForGroup(group) {
  const baseUrl = storeBaseUrl(group.storeId);
  const lines = (group.items || [])
    .filter((item) => item.variantId)
    .map((item) => `${item.variantId}:${item.quantity}`);
  if (baseUrl && lines.length) return `${baseUrl}/cart/${lines.join(",")}`;
  return group.items?.[0]?.cartUrl || group.items?.[0]?.url || baseUrl || "#";
}

function deliveryForGroup(group) {
  const shipping = storeById(group.storeId)?.shipping;
  if (!shipping) {
    return {
      name: "Delivery unavailable",
      price: 0,
      eligible: false,
      source: "missing",
    };
  }

  const minSubtotal = Number(shipping.minSubtotal || 0);
  if (minSubtotal && group.total < minSubtotal) {
    return {
      ...shipping,
      price: Number(shipping.price || 0),
      eligible: false,
      shortfall: minSubtotal - group.total,
    };
  }

  return {
    ...shipping,
    price: Number(shipping.price || 0),
    eligible: true,
  };
}

function cartItemFromListing(card, listing, quantity) {
  const selectedQuantity = clampQuantity(quantity, listing.maxQuantity);
  return {
    cardKey: normalizeKey(card.name),
    sourceId: listing.id,
    name: card.name,
    requestedQuantity: card.quantity,
    quantity: selectedQuantity,
    maxQuantity: listing.maxQuantity || null,
    unitPrice: listing.priceMin,
    lineTotal: selectedQuantity * listing.priceMin,
    store: listing.store,
    storeId: listing.storeId,
    title: listing.title,
    condition: listing.condition || "",
    set: listing.set || "",
    image: listing.image || "",
    url: listing.url,
    cartUrl: listing.cartUrl || listing.url,
    cartSupport: listing.cartSupport || "listing",
    variantId: listing.variantId || "",
  };
}

function prepareCart(data) {
  const deliveredItems = buildDeliveredCartItems(data);
  cartItems = deliveredItems.length
    ? deliveredItems
    : (data.cardResults || [])
      .filter((card) => card.bestOverall)
      .map((card) => cartItemFromListing(card, card.bestOverall, card.selectedQuantity || card.quantity));
}

function listingCanCover(card, listing) {
  return !listing.maxQuantity || listing.maxQuantity >= card.quantity;
}

function buildDeliveredCartItems(data) {
  const cards = data.cardResults || [];
  const stores = data.stores || [];
  if (!cards.length || !stores.length) return [];

  let best = null;
  const storeIds = stores.map((store) => store.id);

  for (let mask = 1; mask < (1 << storeIds.length); mask += 1) {
    const allowed = new Set(storeIds.filter((_, index) => mask & (1 << index)));
    const items = [];
    let feasible = true;

    for (const card of cards) {
      const listing = (card.listings || [])
        .filter((item) => allowed.has(item.storeId))
        .filter((item) => listingCanCover(card, item))
        .sort((a, b) => a.priceMin - b.priceMin || a.store.localeCompare(b.store) || a.title.localeCompare(b.title))[0];

      if (!listing) {
        feasible = false;
        break;
      }

      items.push(cartItemFromListing(card, listing, card.quantity));
    }

    if (!feasible) continue;
    const groups = buildGroupsFromItems(items);
    if (groups.some((group) => !group.delivery?.eligible)) continue;
    const deliveredTotal = groups.reduce((sum, group) => sum + group.total + group.delivery.price, 0);
    if (!best || deliveredTotal < best.deliveredTotal) best = { items, deliveredTotal };
  }

  return best?.items || [];
}

function optimizeCart() {
  if (!currentData) return;
  const deliveredItems = buildDeliveredCartItems(currentData);
  cartItems = deliveredItems.length
    ? deliveredItems
    : (currentData.cardResults || [])
      .filter((card) => card.bestOverall)
      .map((card) => cartItemFromListing(card, card.bestOverall, card.selectedQuantity || card.quantity));
  collapsedCards.clear();
  panelsCollapseByDefault = false;
  renderCheckoutPlan();
  renderResults(currentData, { preserveCart: true });
}

function selectListing(cardKey, listingId) {
  const card = (currentData?.cardResults || []).find((item) => normalizeKey(item.name) === cardKey);
  const listing = resultById(listingId);
  if (!card || !listing) return;

  const existing = cartItems.find((item) => item.cardKey === cardKey);
  const wantedQuantity = existing?.quantity || card.quantity || 1;
  const nextItem = cartItemFromListing(card, listing, wantedQuantity);
  const existingIndex = cartItems.findIndex((item) => item.cardKey === cardKey);
  if (existingIndex >= 0) cartItems[existingIndex] = nextItem;
  else cartItems.push(nextItem);
  renderCheckoutPlan();
  renderResults(currentData, { preserveCart: true });
}

function updateCartQuantity(cardKey, delta) {
  const item = cartItems.find((entry) => entry.cardKey === cardKey);
  if (!item) return;
  item.quantity = clampQuantity(item.quantity + delta, item.maxQuantity);
  item.lineTotal = item.quantity * item.unitPrice;
  renderCheckoutPlan();
  renderResults(currentData, { preserveCart: true });
}

function removeCartItem(cardKey) {
  cartItems = cartItems.filter((item) => item.cardKey !== cardKey);
  renderCheckoutPlan();
  renderResults(currentData, { preserveCart: true });
}

function buildGroupsFromItems(items) {
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
    item.lineTotal = item.quantity * item.unitPrice;
    item.cartUrl = cartUrlForItem(item);
    group.total += item.lineTotal;
    group.items.push(item);
  }

  const groups = [...byStore.values()].sort((a, b) => b.total - a.total || a.store.localeCompare(b.store));
  groups.forEach((group) => {
    group.delivery = deliveryForGroup(group);
    group.deliveredTotal = group.delivery.eligible ? group.total + group.delivery.price : null;
    group.cartUrl = cartUrlForGroup(group);
  });
  return groups;
}

function buildGroupedCart() {
  return buildGroupsFromItems(cartItems);
}

function renderResults(data, options = {}) {
  currentData = data;
  if (!options.preserveCart) prepareCart(data);

  const cardResults = data.cardResults || [];
  const allResults = data.results || [];
  const foundCards = cardResults.filter((card) => card.bestOverall).length;
  const missingCards = Math.max(cardResults.length - foundCards, 0);

  summaryEl.hidden = false;
  summaryEl.innerHTML = allResults.length
    ? `<strong>${foundCards}</strong> of <strong>${cardResults.length}</strong> card lines found across <strong>${escapeHtml(data.stores.length)}</strong> stores. Cart is optimized for card prices plus delivery.${missingCards ? ` <strong>${missingCards}</strong> missing.` : ""}`
    : `No listings found for <strong>${escapeHtml(data.query)}</strong>.`;

  const errors = (data.errors || []).slice(0, 4).map((error) => `${error.store}: ${error.message}`).join(" | ");
  statusEl.textContent = errors
    ? `Searched ${data.stores.length} stores. Some searches failed: ${errors}`
    : `Searched ${data.stores.length} stores. Showing cheapest available copy per store, plus the lowest print/art options found.`;

  if (!cardResults.length) {
    checkoutPlanEl.hidden = true;
    resultsEl.innerHTML = `<div class="empty">Try the exact card name printed on the card. The stores return product search matches, so broad mechanics or nicknames can miss.</div>`;
    return;
  }

  renderCheckoutPlan();

  resultsEl.innerHTML = cardResults.map((card) => {
    return renderCardPanel(card);
  }).join("");
}

function selectedCartItemForCard(card) {
  return cartItems.find((item) => item.cardKey === normalizeKey(card.name)) || null;
}

function selectedListingForCard(card) {
  const selected = selectedCartItemForCard(card);
  if (!selected) return card.bestOverall;
  return (card.listings || []).find((item) => item.id === selected.sourceId) || selected;
}

function renderCardPanel(card) {
  const cardKey = normalizeKey(card.name);
  const collapsed = collapsedCards.has(cardKey) ? collapsedCards.get(cardKey) : panelsCollapseByDefault;
  const selected = selectedListingForCard(card);
  const best = selected
    ? `${escapeHtml(selected.store)} ${money(selected.priceMin || selected.unitPrice)} each`
    : "No available copies found";
  const anchor = `card-panel-${idKey(card.name)}`;

  return `
    <article class="card-group ${collapsed ? "collapsed" : ""}" id="${escapeHtml(anchor)}">
      <header class="card-group-header">
        <h2>${escapeHtml(card.requestedQuantity || card.quantity)}x ${escapeHtml(card.name)}</h2>
        <div class="card-header-actions">
          <div class="best">Selected: ${best}</div>
          <button class="secondary-button" type="button" data-toggle-card="${escapeHtml(cardKey)}">${collapsed ? "Expand" : "Collapse"}</button>
        </div>
      </header>
      <div class="card-detail-layout">
        ${renderSelectedPreview(card, selected)}
        ${collapsed ? "" : `<div class="card-options">${renderStoreCarousels(card)}</div>`}
      </div>
    </article>
  `;
}

function renderSelectedPreview(card, selected) {
  if (!selected) {
    return `
      <aside class="selected-preview empty-preview">
        <div class="preview-label">Selected card</div>
        <div>No available copy found</div>
      </aside>
    `;
  }

  const price = selected.priceMin ?? selected.unitPrice;
  const quantity = clampQuantity(card.quantity, selected.maxQuantity);
  const stock = selected.maxQuantity ? `${selected.maxQuantity} max` : "Stock hidden";
  const image = selected.image
    ? `<span class="art-zoom-wrap preview-art-wrap"><img class="preview-art" src="${escapeHtml(selected.image)}" alt="${escapeHtml(selected.title)}" loading="lazy"><span class="art-preview"><img src="${escapeHtml(selected.image)}" alt=""></span></span>`
    : `<div class="preview-art art-placeholder" aria-hidden="true"></div>`;

  return `
    <aside class="selected-preview">
      <div class="preview-label">Selected for cart</div>
      ${image}
      <div class="store">${escapeHtml(selected.store)}</div>
      <h3>${escapeHtml(selected.title)}</h3>
      <div class="price">${money(price)}</div>
      ${quantity > 1 ? `<div class="unit">${escapeHtml(quantity)} copies: ${money(price * quantity)}</div>` : ""}
      <div class="meta">
        ${selected.condition ? `<span>${escapeHtml(selected.condition)}</span>` : ""}
        ${selected.set ? `<span>${escapeHtml(selected.set)}</span>` : ""}
        <span>${escapeHtml(stock)}</span>
      </div>
      <a class="mini-button listing-button" href="${escapeHtml(selected.url)}" target="_blank" rel="noreferrer">Open listing</a>
    </aside>
  `;
}

function emptyStoreRows() {
  return (currentData?.stores || []).map((store) => ({
    store: store.name,
    storeId: store.id,
    missing: true,
  }));
}

function emptyCardResult(card) {
  return {
    ...card,
    requestedQuantity: card.quantity,
    selectedQuantity: 0,
    stores: emptyStoreRows(),
    printings: [],
    listings: [],
    bestOverall: null,
    bestTotal: null,
  };
}

async function fetchCardSearch(card, signal) {
  const response = await fetch("/api/search?limit=20", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ q: `${card.quantity} ${card.name}`, mode: "single" }),
    signal,
  });
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Search failed");
  }

  return data;
}

function mergeSearchData(target, source, cardIndex, fallbackCard) {
  if (!target.stores.length) target.stores = source.stores || [];
  target.errors.push(...(source.errors || []));
  target.checkoutPlan.missing.push(...(source.checkoutPlan?.missing || []));
  target.cardResults[cardIndex] = source.cardResults?.[0] || emptyCardResult(fallbackCard);
  target.results = target.cardResults
    .filter(Boolean)
    .flatMap((card) => (card.stores || []).filter((store) => !store.missing));
}

function renderPartialResults(data, done, total) {
  const visibleData = {
    ...data,
    cardResults: data.cardResults.filter(Boolean),
  };
  renderResults(visibleData);
  statusEl.textContent = `Searched ${done} of ${total} cards. Results update as each card finishes.`;
}

async function searchBatchProgressively(query, cards) {
  const combined = {
    query,
    cards,
    searchedAt: new Date().toISOString(),
    stores: [],
    errors: [],
    cardResults: new Array(cards.length),
    checkoutPlan: { groups: [], missing: [], total: 0 },
    results: [],
  };
  let done = 0;

  for (let index = 0; index < cards.length; index += 1) {
    if (searchCancelled) break;
    setProgressCard(index, "current", searchingStoresText());
    try {
      const data = await fetchCardSearch(cards[index], activeSearchController?.signal);
      mergeSearchData(combined, data, index, cards[index]);
      const found = data.cardResults?.[0]?.bestOverall;
      setProgressCard(index, "done", found ? "Done" : "No available copies found");
    } catch (error) {
      if (error.name === "AbortError" || searchCancelled) {
        setProgressCard(index, "error", "Cancelled");
        break;
      }
      if (!combined.stores.length && currentData?.stores?.length) combined.stores = currentData.stores;
      combined.errors.push({ card: cards[index].name, store: "Local app", message: error.message });
      combined.cardResults[index] = emptyCardResult(cards[index]);
      setProgressCard(index, "error", error.message);
    }

    done += 1;
    updateProgress(done, cards.length);
    renderPartialResults(combined, done, cards.length);
  }

  stopProgress();
  progressTitleEl.textContent = searchCancelled ? "Search cancelled" : "Finished checking stores";
  progressCountEl.textContent = searchCancelled ? `${done} / ${cards.length}` : "Done";
  if (!searchCancelled) progressFillEl.style.width = "100%";
  renderResults({
    ...combined,
    cardResults: combined.cardResults.filter(Boolean),
  });
  if (searchCancelled) statusEl.textContent = `Search cancelled after ${done} of ${cards.length} cards.`;
}

function listingsByStore(card) {
  const byStore = new Map();
  for (const store of currentData?.stores || []) {
    byStore.set(store.id, {
      store: store.name,
      storeId: store.id,
      listings: [],
    });
  }

  for (const item of card.listings || []) {
    if (!byStore.has(item.storeId)) {
      byStore.set(item.storeId, {
        store: item.store,
        storeId: item.storeId,
        listings: [],
      });
    }
    byStore.get(item.storeId).listings.push(item);
  }

  return [...byStore.values()].map((group) => ({
    ...group,
    listings: group.listings.sort((a, b) => a.priceMin - b.priceMin || a.title.localeCompare(b.title)),
  }));
}

function carouselKey(card, storeId) {
  return `${normalizeKey(card.name)}:${storeId}`;
}

function carouselIndex(card, storeId, total) {
  const key = carouselKey(card, storeId);
  const value = carouselPositions.get(key) || 0;
  return Math.max(0, Math.min(value, Math.max(total - 1, 0)));
}

function setCarouselIndex(cardKey, storeId, direction) {
  const card = (currentData?.cardResults || []).find((item) => normalizeKey(item.name) === cardKey);
  if (!card) return;
  const group = listingsByStore(card).find((item) => item.storeId === storeId);
  if (!group?.listings.length) return;
  const key = carouselKey(card, storeId);
  const current = carouselIndex(card, storeId, group.listings.length);
  const next = Math.max(0, Math.min(current + direction, group.listings.length - 1));
  carouselPositions.set(key, next);
  renderResults(currentData, { preserveCart: true });
}

function renderStoreCarousels(card) {
  const groups = listingsByStore(card);
  if (!groups.length) return "";

  return `
    <section class="store-carousel-panel">
      <div class="printing-title">Stores and art options</div>
      <div class="store-carousel-grid">
        ${groups.map((group) => renderStoreCarousel(group, card)).join("")}
      </div>
    </section>
  `;
}

function renderStoreCarousel(group, card) {
  if (!group.listings.length) {
    return `
      <div class="store-carousel missing-card">
        <div>
          <div class="store">${escapeHtml(group.store)}</div>
          <div>No available copy found</div>
        </div>
      </div>
    `;
  }

  const index = carouselIndex(card, group.storeId, group.listings.length);
  const item = group.listings[index];
  const selected = selectedCartItemForCard(card);
  const isSelected = selected?.sourceId === item.id;
  const stock = item.maxQuantity ? `${item.maxQuantity} max` : "Stock hidden";
  const quantity = clampQuantity(card.quantity, item.maxQuantity);
  const image = item.image
    ? `<span class="art-zoom-wrap"><img class="card-art" src="${escapeHtml(item.image)}" alt="${escapeHtml(item.title)}" loading="lazy"><span class="art-preview"><img src="${escapeHtml(item.image)}" alt=""></span></span>`
    : `<div class="art-placeholder" aria-hidden="true"></div>`;
  const prevDisabled = index <= 0 ? "disabled" : "";
  const nextDisabled = index >= group.listings.length - 1 ? "disabled" : "";

  return `
    <div class="store-carousel ${isSelected ? "selected-option" : ""}">
      <div class="carousel-head">
        <div>
          <div class="store">${escapeHtml(group.store)}</div>
          <div class="carousel-rank">Option ${escapeHtml(index + 1)} of ${escapeHtml(group.listings.length)} - cheapest first</div>
        </div>
        <div class="carousel-buttons">
          <button class="icon-button" type="button" data-carousel-card="${escapeHtml(normalizeKey(card.name))}" data-carousel-store="${escapeHtml(group.storeId)}" data-carousel-dir="-1" ${prevDisabled} aria-label="Show cheaper art for ${escapeHtml(group.store)}">&lt;</button>
          <button class="icon-button" type="button" data-carousel-card="${escapeHtml(normalizeKey(card.name))}" data-carousel-store="${escapeHtml(group.storeId)}" data-carousel-dir="1" ${nextDisabled} aria-label="Show more expensive art for ${escapeHtml(group.store)}">&gt;</button>
        </div>
      </div>
      <div class="carousel-body">
        ${image}
        <div>
          <h3>${escapeHtml(item.title)}</h3>
          <div class="price">${money(item.priceMin)}</div>
          ${quantity > 1 ? `<div class="unit">${escapeHtml(quantity)} copies: ${money(item.priceMin * quantity)}</div>` : ""}
          <div class="meta">
            ${item.condition ? `<span>${escapeHtml(item.condition)}</span>` : ""}
            ${item.set ? `<span>${escapeHtml(item.set)}</span>` : ""}
            <span>${escapeHtml(stock)}</span>
          </div>
          <div class="store-actions">
            <button class="secondary-button" type="button" data-select-card="${escapeHtml(normalizeKey(card.name))}" data-listing-id="${escapeHtml(item.id)}">${isSelected ? "Selected" : "Use in cart"}</button>
            <a class="mini-button listing-button" href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">Open listing</a>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderCheckoutPlan() {
  const groups = buildGroupedCart();
  const removedCount = Math.max((currentData?.cardResults || []).length - cartItems.length, 0);

  if (!groups.length) {
    checkoutPlanEl.hidden = false;
    checkoutPlanEl.innerHTML = `
      <div class="plan-header">
        <h2>Cheapest Delivered Cart</h2>
        <div class="plan-total">${money(0)}</div>
      </div>
      <div class="empty compact">All split-cart items have been removed.</div>
    `;
    return;
  }

  const total = groups.reduce((sum, group) => sum + group.total, 0);
  const deliveryTotal = groups.reduce((sum, group) => sum + (group.delivery?.eligible ? group.delivery.price : 0), 0);
  const deliveredTotal = total + deliveryTotal;
  checkoutPlanEl.hidden = false;
  checkoutPlanEl.innerHTML = `
    <div class="plan-header">
      <h2>Cheapest Delivered Cart</h2>
      <div class="plan-tools">
        <button class="secondary-button" type="button" data-cart-action="optimize">Optimize Cart</button>
        <div class="plan-total">${money(deliveredTotal)} <small>cards ${money(total)} + delivery ${money(deliveryTotal)}</small></div>
      </div>
    </div>
    <div class="plan-grid">
      ${groups.map(renderPlanStore).join("")}
    </div>
    ${renderMissingNote(removedCount)}
  `;
}

function renderPlanStore(group) {
  const delivery = group.delivery || { name: "Delivery unavailable", price: 0, eligible: false };
  const deliveryText = delivery.eligible
    ? `${escapeHtml(delivery.name)} ${money(delivery.price)}`
    : delivery.shortfall
      ? `Delivery minimum short by ${money(delivery.shortfall)}`
      : "Delivery unavailable";
  return `
    <div class="plan-store">
      <div class="plan-store-head">
        <h3>${escapeHtml(group.store)} - ${money(group.deliveredTotal || group.total)}</h3>
        <a class="checkout-button" href="${escapeHtml(group.cartUrl || group.items[0]?.cartUrl || "#")}" target="_blank" rel="noreferrer">Batch Checkout</a>
      </div>
      <div class="delivery-line">${deliveryText}</div>
      <ul>
        ${(group.items || []).map(renderPlanItem).join("")}
      </ul>
    </div>
  `;
}

function renderPlanItem(item) {
  const maxLabel = item.maxQuantity ? `Max ${item.maxQuantity}` : "Store hides stock";
  const directLabel = item.cartSupport === "direct" ? "Add to cart" : "Open listing";
  const disableMinus = item.quantity <= 1 ? "disabled" : "";
  const disablePlus = item.maxQuantity && item.quantity >= item.maxQuantity ? "disabled" : "";

  return `
    <li class="plan-line">
      <div class="plan-line-main">
        <a href="#card-panel-${escapeHtml(idKey(item.name))}" data-jump-card="${escapeHtml(item.cardKey)}">${escapeHtml(item.name)}</a>
        <small>${money(item.unitPrice)} each${item.condition ? `, ${escapeHtml(item.condition)}` : ""}${item.set ? `, ${escapeHtml(item.set)}` : ""}</small>
        <div class="quantity-row">
          <button class="icon-button" type="button" data-cart-action="minus" data-card-key="${escapeHtml(item.cardKey)}" ${disableMinus} aria-label="Decrease ${escapeHtml(item.name)} quantity">-</button>
          <span>${escapeHtml(item.quantity)}</span>
          <button class="icon-button" type="button" data-cart-action="plus" data-card-key="${escapeHtml(item.cardKey)}" ${disablePlus} aria-label="Increase ${escapeHtml(item.name)} quantity">+</button>
          <em>${escapeHtml(maxLabel)}</em>
        </div>
      </div>
      <div class="plan-line-actions">
        <strong>${money(item.lineTotal)}</strong>
        <a class="mini-button" href="${escapeHtml(item.cartUrl)}" target="_blank" rel="noreferrer">${directLabel}</a>
        <button class="remove-button" type="button" data-cart-action="remove" data-card-key="${escapeHtml(item.cardKey)}">Remove</button>
      </div>
    </li>
  `;
}

function renderMissingNote(removedCount) {
  const notes = [];
  const missing = currentData?.checkoutPlan?.missing || [];
  if (missing.length) {
    const totalMissing = missing.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    notes.push(`${totalMissing} requested copies are not covered by known stock.`);
  }
  if (removedCount) notes.push(`${removedCount} card lines removed from the split cart.`);
  return notes.length ? `<p>${notes.map(escapeHtml).join(" ")}</p>` : "";
}

function renderStoreCard(item, card) {
  if (item.missing) {
    return `
      <div class="missing-card">
        <div>
          <div class="store">${escapeHtml(item.store)}</div>
          <div>No available copy found</div>
        </div>
      </div>
    `;
  }

  const image = item.image
    ? `<img src="${escapeHtml(item.image)}" alt="${escapeHtml(item.title)}" loading="lazy">`
    : `<div class="art-placeholder" aria-hidden="true"></div>`;
  const quantity = clampQuantity(card.quantity, item.maxQuantity);
  const stock = item.maxQuantity ? `${item.maxQuantity} max` : "Stock hidden";

  return `
    <div class="store-card">
      ${image}
      <div>
        <div class="store">${escapeHtml(item.store)}</div>
        <h3>${escapeHtml(item.title)}</h3>
        <div class="price">${money(item.priceMin)}</div>
        ${quantity > 1 ? `<div class="unit">${escapeHtml(quantity)} copies: ${money(item.priceMin * quantity)}</div>` : ""}
        <div class="meta">
          ${item.condition ? `<span>${escapeHtml(item.condition)}</span>` : ""}
          ${item.set ? `<span>${escapeHtml(item.set)}</span>` : ""}
          <span>${escapeHtml(stock)}</span>
        </div>
        <div class="store-actions">
          <button class="secondary-button" type="button" data-select-card="${escapeHtml(normalizeKey(card.name))}" data-listing-id="${escapeHtml(item.id)}">Use in cart</button>
          <a href="${escapeHtml(item.url)}" target="_blank" rel="noreferrer">Open listing</a>
        </div>
      </div>
    </div>
  `;
}

async function search() {
  let query = input.value.trim();
  if (!query) {
    input.focus();
    return;
  }

  activeSearchController = new AbortController();
  searchCancelled = false;
  setSearchingState(true);
    summaryEl.hidden = true;
    checkoutPlanEl.hidden = true;
    resultsEl.innerHTML = "";
  collapsedCards.clear();
  panelsCollapseByDefault = false;
  carouselPositions.clear();
  statusEl.textContent = "Searching Singapore stores for pasted decklist...";

  try {
    if (isMoxfieldUrl(query)) {
      statusEl.textContent = "Importing Moxfield deck...";
      query = await importMoxfieldDeck(query, activeSearchController.signal);
    }

    const progressCards = parseInputCards(query);
    startProgress(progressCards);

    if (progressCards.length > 1) {
      await searchBatchProgressively(query, progressCards);
      return;
    }

    setProgressCard(0, "current", searchingStoresText());
    const response = await fetch("/api/search?limit=20", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ q: query, mode: "batch" }),
      signal: activeSearchController.signal,
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Search failed");
    }

    renderResults(data);
    updateProgress(1, 1);
    finishProgress(true, "Done");
  } catch (error) {
    if (error.name === "AbortError" || searchCancelled) {
      finishProgress(false, "Cancelled");
      statusEl.textContent = "Search cancelled.";
      return;
    }
    finishProgress(false, error.message);
    statusEl.textContent = error.message;
    resultsEl.innerHTML = `<div class="empty">The local app is running, but the store request failed. Check your connection and try again.</div>`;
  } finally {
    activeSearchController = null;
    setSearchingState(false);
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  search();
});

checkoutPlanEl.addEventListener("click", (event) => {
  const jumpLink = event.target.closest("[data-jump-card]");
  if (jumpLink) {
    event.preventDefault();
    collapsedCards.set(jumpLink.dataset.jumpCard, false);
    renderResults(currentData, { preserveCart: true });
    const target = document.querySelector(jumpLink.getAttribute("href"));
    if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }

  const button = event.target.closest("[data-cart-action]");
  if (!button) return;

  const cardKey = button.dataset.cardKey;
  if (button.dataset.cartAction === "optimize") optimizeCart();
  if (button.dataset.cartAction === "minus") updateCartQuantity(cardKey, -1);
  if (button.dataset.cartAction === "plus") updateCartQuantity(cardKey, 1);
  if (button.dataset.cartAction === "remove") removeCartItem(cardKey);
});

resultsEl.addEventListener("click", (event) => {
  const toggle = event.target.closest("[data-toggle-card]");
  if (toggle) {
    const key = toggle.dataset.toggleCard;
    const currentlyCollapsed = collapsedCards.has(key) ? collapsedCards.get(key) : panelsCollapseByDefault;
    collapsedCards.set(key, !currentlyCollapsed);
    renderResults(currentData, { preserveCart: true });
    return;
  }

  const carouselButton = event.target.closest("[data-carousel-dir]");
  if (carouselButton) {
    setCarouselIndex(
      carouselButton.dataset.carouselCard,
      carouselButton.dataset.carouselStore,
      Number(carouselButton.dataset.carouselDir),
    );
    return;
  }

  const button = event.target.closest("[data-select-card]");
  if (!button) return;
  selectListing(button.dataset.selectCard, button.dataset.listingId);
});

cancelButton.addEventListener("click", () => {
  searchCancelled = true;
  cancelButton.disabled = true;
  statusEl.textContent = "Cancelling search...";
  activeSearchController?.abort();
});
