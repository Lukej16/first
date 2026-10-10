/* =========================================================================
   Commander Notes — app logic
   Plain JavaScript, no libraries, no build step.

   How the file is organised:
     1.  Settings you can tweak
     2.  Saving and loading (your notes live on this device)
     3.  Small helpers
     4.  Talking to the Scryfall API
     5.  Home screen: the commander carousel
     6.  Deck screen: cards to add / cards to drop
     7.  The search sheet (adding commanders and cards, and Quick note)
     8.  The card sheet (why, strikes, swaps, prices, where to buy)
     9.  The history sheet (changes you've made)
     10. Backup and restore
     11. Wiring the buttons up

   How the saved data is shaped:
     {
       lastCommanderId,          // the deck you opened most recently
       commanders: [
         {
           id, card,             // card = the details we got from Scryfall
           add:  [ entry, ... ],
           drop: [ entry, ... ]
         }
       ]
     }
   and each entry looks like:
     { id, card, note, reasons: [], strikes, pairId, doneAt, addedAt }
       strikes = how many times you've flagged it
       pairId  = the id of the card it swaps with, in the other list
       doneAt  = when you made the change (empty means still to do)
   ========================================================================= */


/* =========================================================================
   1. SETTINGS YOU CAN TWEAK
   ========================================================================= */
const SETTINGS = {
  // The name your notes are saved under in the browser.
  // Changing this starts you with an empty notepad.
  STORAGE_KEY: "commander-notes-v1",

  // How long to wait after you stop typing before searching Scryfall.
  // Scryfall asks apps not to send lots of requests per second.
  SEARCH_DELAY_MS: 250,

  // Don't search until at least this many letters are typed.
  MIN_SEARCH_LETTERS: 2,

  // How many name suggestions to show while you type.
  MAX_SUGGESTIONS: 8,

  // How long the little pop-up messages stay on screen.
  TOAST_MS: 2200,

  // The one-tap reasons on the card sheet. Add, remove or reword freely.
  REASONS: {
    add: ["Great synergy", "Strong at my table", "Saw it in another deck", "Upgrade"],
    drop: ["Too slow", "Never drew it", "Dead card", "Too pricey", "Doesn't fit"],
  },
};

// Friendly names for the shops Scryfall links to.
const STORE_NAMES = {
  tcgplayer: "TCGplayer",
  cardmarket: "Cardmarket",
  cardhoarder: "Cardhoarder (MTGO)",
};

const LIST_TITLES = {
  add: "Cards to add",
  drop: "Cards to drop",
};


/* =========================================================================
   2. SAVING AND LOADING
   Everything is saved in the browser's localStorage, which stays on
   this phone. There's no account yet, so nothing leaves the device.
   ========================================================================= */
let data = loadData();

function loadData() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS.STORAGE_KEY));
    if (isValidData(saved)) return normalize(saved);
  } catch (error) {
    // Missing or unreadable data: start with an empty notepad.
  }
  return { lastCommanderId: null, commanders: [] };
}

function saveData() {
  try {
    localStorage.setItem(SETTINGS.STORAGE_KEY, JSON.stringify(data));
  } catch (error) {
    console.warn("Could not save your notes:", error);
  }
}

// Does this look like Commander Notes data? Used for saved data and backups.
function isValidData(value) {
  return Boolean(value) && Array.isArray(value.commanders) &&
    value.commanders.every((c) => c && c.card && typeof c.card.name === "string");
}

// Fill in anything missing, so notes saved by an older version still work.
function normalize(value) {
  value.lastCommanderId = value.lastCommanderId || null;
  value.commanders.forEach((commander) => {
    commander.id = commander.id || makeId();
    ["add", "drop"].forEach((list) => {
      commander[list] = Array.isArray(commander[list]) ? commander[list] : [];
      commander[list].forEach((entry) => {
        entry.id = entry.id || makeId();
        entry.note = entry.note || "";
        entry.reasons = Array.isArray(entry.reasons) ? entry.reasons : [];
        entry.strikes = entry.strikes || 1;
        entry.pairId = entry.pairId || null;
        entry.doneAt = entry.doneAt || null;
        entry.addedAt = entry.addedAt || Date.now();
      });
    });
  });
  return value;
}


/* =========================================================================
   3. SMALL HELPERS
   ========================================================================= */
const $ = (id) => document.getElementById(id);

// Which commander is open on the deck screen right now.
let currentCommanderId = null;

// A short random id, so we can tell entries apart.
function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Create an element with an optional class and text in one line.
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className, text, onClick) {
  const node = el("button", className, text);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

function findCommander(id) {
  return data.commanders.find((commander) => commander.id === id);
}

function currentCommander() {
  return findCommander(currentCommanderId);
}

// Look for an entry by id in both lists. Returns { entry, list } or null.
function findEntry(commander, entryId) {
  for (const list of ["add", "drop"]) {
    const entry = commander[list].find((e) => e.id === entryId);
    if (entry) return { entry, list };
  }
  return null;
}

// The entries still to do (not marked as done).
function activeEntries(commander, list) {
  return commander[list].filter((entry) => !entry.doneAt);
}

function otherList(list) {
  return list === "add" ? "drop" : "add";
}

// The first part of a long name: "Atraxa, Praetors' Voice" → "Atraxa".
function shortName(name) {
  return name.split(/[,/]/)[0].trim();
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function showScreen(id) {
  document.querySelectorAll(".screen").forEach((screen) => {
    screen.classList.toggle("is-visible", screen.id === id);
  });
  window.scrollTo(0, 0);
}

// Open a <dialog>, unless it's already open (opening twice is an error).
function openSheet(id) {
  const sheet = $(id);
  if (!sheet.open) sheet.showModal();
}

// The card's picture, or a box with its name if there is no picture.
function cardImage(card) {
  if (!card.image) return el("div", "card-image card-image--missing", card.name);

  const img = el("img", "card-image");
  img.src = card.image;
  img.alt = card.name;
  img.loading = "lazy";
  // If the picture fails to load, swap in the name box instead.
  img.addEventListener("error", () => img.replaceWith(el("div", "card-image card-image--missing", card.name)));
  return img;
}

// A small message that slides up from the bottom for a moment.
let toastTimer = null;
function toast(message) {
  const box = $("toast");
  box.textContent = message;
  box.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove("is-visible"), SETTINGS.TOAST_MS);
}

// Copy text to the clipboard, with an older fallback for browsers that need it.
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    const box = el("textarea");
    box.value = text;
    document.body.append(box);
    box.select();
    const worked = document.execCommand("copy");
    box.remove();
    return worked;
  }
}


/* =========================================================================
   4. TALKING TO THE SCRYFALL API
   Scryfall is a free Magic card database. Docs: https://scryfall.com/docs/api
   ========================================================================= */
const SCRYFALL = "https://api.scryfall.com";

async function scryfallGet(path) {
  const response = await fetch(SCRYFALL + path);
  if (!response.ok) {
    const error = new Error("Scryfall replied with " + response.status);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

// Cards matching a Scryfall search, most-played in Commander first.
// Scryfall answers 404 when nothing matches, and 400 if the search
// text confuses it. Both just mean "no cards".
async function searchCards(query) {
  try {
    const result = await scryfallGet("/cards/search?unique=cards&order=edhrec&q=" + encodeURIComponent(query));
    return result.data.slice(0, SETTINGS.MAX_SUGGESTIONS).map(cardFromScryfall);
  } catch (error) {
    if (error.status === 404 || error.status === 400) return [];
    throw error;
  }
}

async function fetchCardById(scryfallId) {
  return cardFromScryfall(await scryfallGet("/cards/" + scryfallId));
}

// Scryfall sends back a LOT of fields. Keep only the ones this app uses.
function cardFromScryfall(raw) {
  // Double-faced cards keep their pictures on each face instead of at the top.
  const images = raw.image_uris || (raw.card_faces && raw.card_faces[0].image_uris) || {};
  return {
    scryfallId: raw.id,
    name: raw.name,
    typeLine: raw.type_line || "",
    colorIdentity: raw.color_identity || [],
    image: images.normal || "",
    art: images.art_crop || "",
    scryfallUrl: raw.scryfall_uri,
    prices: raw.prices || {},
    buyLinks: raw.purchase_uris || {},
  };
}


/* =========================================================================
   5. HOME SCREEN: THE COMMANDER CAROUSEL
   ========================================================================= */
function renderHome() {
  const carousel = $("commander-carousel");
  carousel.replaceChildren();

  data.commanders.forEach((commander) => {
    const toAdd = activeEntries(commander, "add").length;
    const toDrop = activeEntries(commander, "drop").length;
    const tile = button("commander-tile", undefined, () => openDeck(commander.id));
    tile.append(
      cardImage(commander.card),
      el("span", "commander-tile__name", commander.card.name),
      el("span", "commander-tile__counts", `${toAdd} to add · ${toDrop} to drop`)
    );
    carousel.append(tile);
  });

  // The last tile is always "+ Add a commander".
  const addTile = button("commander-tile", undefined, () => openSearch("commander"));
  addTile.append(
    el("span", "commander-tile__blank", "+"),
    el("span", "commander-tile__name", "Add a commander")
  );
  carousel.append(addTile);

  $("home-hint").textContent = data.commanders.length
    ? "Swipe to see all your decks →"
    : "Tap the + to add your first commander.";
  $("quick-note").hidden = data.commanders.length === 0;
}

function addCommander(card) {
  if (data.commanders.some((commander) => commander.card.name === card.name)) {
    setSearchStatus(`${card.name} is already in your decks.`);
    return false;
  }
  data.commanders.push({ id: makeId(), card, add: [], drop: [] });
  saveData();
  renderHome();
  // Slide the carousel so the new commander is in view.
  const carousel = $("commander-carousel");
  const newTile = carousel.children[carousel.children.length - 2];
  newTile.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  return true;
}


/* =========================================================================
   6. DECK SCREEN: CARDS TO ADD / CARDS TO DROP
   ========================================================================= */
function openDeck(commanderId) {
  currentCommanderId = commanderId;
  data.lastCommanderId = commanderId;
  saveData();
  renderDeck();
  showScreen("screen-deck");
  fillInColorIdentity(currentCommander());
}

// Commanders saved by an older version don't know their colors yet.
// Look them up once so card search can stick to the deck's colors.
async function fillInColorIdentity(commander) {
  if (!commander || commander.card.colorIdentity) return;
  try {
    commander.card = await fetchCardById(commander.card.scryfallId);
    saveData();
  } catch (error) {
    // Offline: try again next time the deck is opened.
  }
}

function renderDeck() {
  const commander = currentCommander();
  if (!commander) return;

  $("deck-title").textContent = commander.card.name;

  const art = $("deck-art");
  art.replaceChildren();
  if (commander.card.art) {
    const img = el("img");
    img.src = commander.card.art;
    img.alt = "";
    art.append(img);
  }

  renderRow("add");
  renderRow("drop");
  renderShopping();
}

function renderRow(list) {
  const commander = currentCommander();
  const entries = activeEntries(commander, list);
  const row = $("row-" + list);

  $("count-" + list).textContent = entries.length;
  row.replaceChildren();

  if (entries.length === 0) {
    row.append(el("p", "row-empty", list === "add"
      ? "Nothing yet. Saw a card you liked? Add it here."
      : "Nothing yet. Card underperformed? Note it here."));
    return;
  }

  entries.forEach((entry) => {
    const card = button("row-card", undefined, () => openCardSheet(list, entry.id));
    card.append(cardImage(entry.card));

    // Little badges in the corner: note, strikes, swap.
    const badges = el("span", "row-card__badges");
    if (entry.note || entry.reasons.length) badges.append(el("span", "badge", "✎"));
    if (entry.strikes > 1) badges.append(el("span", "badge", "×" + entry.strikes));
    if (entry.pairId) badges.append(el("span", "badge", "⇄"));
    if (badges.children.length) card.append(badges);

    row.append(card);
  });
}

// The shopping list: a rough total of the "Cards to add" prices.
function renderShopping() {
  const entries = activeEntries(currentCommander(), "add");
  $("shopping").hidden = entries.length === 0;

  let total = 0;
  let unpriced = 0;
  entries.forEach((entry) => {
    const price = parseFloat(entry.card.prices.usd || entry.card.prices.usd_foil);
    if (price) total += price;
    else unpriced++;
  });
  $("add-total").textContent = "≈ $" + total.toFixed(2) + (unpriced ? "+" : "");
}

// Copies "1 Card Name" per line, the format TCGplayer and Moxfield accept.
async function copyShoppingList() {
  const entries = activeEntries(currentCommander(), "add");
  const text = entries.map((entry) => "1 " + entry.card.name).join("\n");
  const copied = await copyText(text);
  toast(copied ? `Copied ${plural(entries.length, "card")}. Paste it into TCGplayer or Moxfield.` : "Couldn't copy. Try again.");
}

// Adds a card to a deck's add or drop list. Returns true if the search
// sheet can close, false if there's a message to show instead.
function addCardToList(commanderId, list, card) {
  const commander = findCommander(commanderId);
  const sameCard = (entry) => entry.card.name === card.name;

  // Already on this list? Count it as another strike instead.
  const existing = activeEntries(commander, list).find(sameCard);
  if (existing) {
    existing.strikes++;
    saveData();
    refreshDeckIfOpen(commanderId);
    toast(`${card.name}: flagged again (${existing.strikes} times)`);
    return true;
  }

  if (activeEntries(commander, otherList(list)).some(sameCard)) {
    setSearchStatus(`${card.name} is in ${LIST_TITLES[otherList(list)]}. Tap it there to move it.`);
    return false;
  }

  // New cards go at the front so the latest note is the first one you see.
  commander[list].unshift({
    id: makeId(), card, note: "", reasons: [], strikes: 1,
    pairId: null, doneAt: null, addedAt: Date.now(),
  });
  saveData();
  refreshDeckIfOpen(commanderId);
  if (commanderId === currentCommanderId) $("row-" + list).scrollTo({ left: 0, behavior: "smooth" });
  return true;
}

function refreshDeckIfOpen(commanderId) {
  if (commanderId === currentCommanderId && $("screen-deck").classList.contains("is-visible")) renderDeck();
  else renderHome();
}

function deleteCurrentCommander() {
  const commander = currentCommander();
  if (!commander) return;
  if (!confirm(`Delete ${commander.card.name} and all its notes?`)) return;

  data.commanders = data.commanders.filter((c) => c.id !== commander.id);
  if (data.lastCommanderId === commander.id) data.lastCommanderId = null;
  saveData();
  $("sheet-history").close();
  goHome();
}

function goHome() {
  currentCommanderId = null;
  renderHome();
  showScreen("screen-home");
}


/* =========================================================================
   7. THE SEARCH SHEET
   One pop-up does several jobs:
     "commander" → add a new commander to the carousel
     "add"       → add a card to this deck's "Cards to add"
     "drop"      → add a card to this deck's "Cards to drop"
     "quick"     → Quick note from the home screen: you pick the deck
                   and add/drop inside the sheet itself
   ========================================================================= */
// Where a picked card goes: { commanderId, list }. list is null for a new commander.
let searchTarget = null;
let searchTimer = null;
// Every search gets a number. If an older, slower reply arrives after a
// newer search has started, we can spot it and ignore it.
let searchNumber = 0;
let isPicking = false;

function openSearch(mode) {
  const isQuick = mode === "quick";
  $("quick-controls").hidden = !isQuick;

  if (mode === "commander") {
    searchTarget = { commanderId: null, list: null };
    $("search-title").textContent = "Add a commander";
  } else if (isQuick) {
    const startId = findCommander(data.lastCommanderId) ? data.lastCommanderId : data.commanders[0].id;
    searchTarget = { commanderId: startId, list: "drop" };
    $("search-title").textContent = "Quick note";
    renderQuickControls();
  } else {
    searchTarget = { commanderId: currentCommanderId, list: mode };
    $("search-title").textContent = "Add to " + LIST_TITLES[mode];
  }

  clearSearch();
  openSheet("sheet-search");
  $("search-input").focus();
}

function clearSearch() {
  searchNumber++;
  $("search-input").value = "";
  $("search-results").replaceChildren();
  setSearchStatus("");
}

// The deck chips and the To add / To drop switch in Quick note.
function renderQuickControls() {
  const chips = data.commanders.map((commander) => {
    const chip = button("chip", shortName(commander.card.name), () => {
      searchTarget.commanderId = commander.id;
      renderQuickControls();
      rerunSearch(); // colors may differ between decks
    });
    chip.setAttribute("aria-pressed", commander.id === searchTarget.commanderId);
    return chip;
  });
  $("quick-decks").replaceChildren(...chips);

  document.querySelectorAll("[data-quick-list]").forEach((option) => {
    option.setAttribute("aria-pressed", option.dataset.quickList === searchTarget.list);
  });
}

function setSearchStatus(message) {
  $("search-status").textContent = message;
}

// The Scryfall search text for what's typed, plus the right filters.
function searchQuery(text) {
  if (!searchTarget.list) return text + " is:commander";

  // Only cards that fit the commander's colors and are legal in Commander.
  // "id<=wub" means "color identity is inside white, blue, black".
  const colors = findCommander(searchTarget.commanderId).card.colorIdentity;
  let query = text + " legal:commander";
  if (colors) query += " id<=" + (colors.length ? colors.join("").toLowerCase() : "c");
  return query;
}

// Runs on every key press, but waits for a short pause before searching.
function onSearchInput() {
  clearTimeout(searchTimer);
  const text = $("search-input").value.trim();

  if (text.length < SETTINGS.MIN_SEARCH_LETTERS) {
    searchNumber++;
    $("search-results").replaceChildren();
    setSearchStatus("");
    return;
  }
  searchTimer = setTimeout(() => runSearch(text), SETTINGS.SEARCH_DELAY_MS);
}

function rerunSearch() {
  const text = $("search-input").value.trim();
  if (text.length >= SETTINGS.MIN_SEARCH_LETTERS) runSearch(text);
}

async function runSearch(text) {
  const myNumber = ++searchNumber;
  setSearchStatus("Searching…");

  try {
    const cards = await searchCards(searchQuery(text));
    if (myNumber !== searchNumber) return; // a newer search has started
    renderSuggestions(cards);
    if (cards.length) setSearchStatus("");
    else setSearchStatus(searchTarget.list ? "No cards found in this deck's colors." : "No commanders found.");
  } catch (error) {
    if (myNumber !== searchNumber) return;
    setSearchStatus("Couldn't reach Scryfall. Check your connection.");
  }
}

function renderSuggestions(cards) {
  const items = cards.map((card) => {
    const item = el("li");
    item.append(button("", card.name, () => pickCard(card)));
    return item;
  });
  $("search-results").replaceChildren(...items);
}

function pickCard(card) {
  if (isPicking) return; // ignore double taps
  isPicking = true;
  searchNumber++;        // ignore any search still on its way

  const { commanderId, list } = searchTarget;
  const added = list ? addCardToList(commanderId, list, card) : addCommander(card);
  if (added) {
    $("sheet-search").close();
    if (!$("quick-controls").hidden) {
      toast(`${card.name} → ${shortName(findCommander(commanderId).card.name)}, ${LIST_TITLES[list].toLowerCase()}`);
    }
  }
  isPicking = false;
}


/* =========================================================================
   8. THE CARD SHEET
   Shows the card big, why you noted it, strikes, swaps, prices and shops.
   ========================================================================= */
// Which card is open: { list: "add" or "drop", entryId }
let openEntry = null;

function findOpenEntry() {
  const commander = currentCommander();
  if (!commander || !openEntry) return null;
  return commander[openEntry.list].find((entry) => entry.id === openEntry.entryId) || null;
}

function openCardSheet(list, entryId) {
  openEntry = { list, entryId };
  const entry = findOpenEntry();
  const card = entry.card;

  $("card-list-label").textContent = LIST_TITLES[list];
  $("card-image").replaceChildren(cardImage(card));
  $("card-name").textContent = card.name;
  $("card-type").textContent = card.typeLine;
  $("card-note").value = entry.note;
  $("move-card").textContent = "Move to " + LIST_TITLES[otherList(list)];
  renderCardExtras();
  renderPrices(card);
  $("price-status").textContent = "Checking today's prices…";

  openSheet("sheet-card");
  $("sheet-card").scrollTop = 0;
  refreshPrices(entry);
}

// The parts of the card sheet that change while it's open.
function renderCardExtras() {
  const entry = findOpenEntry();
  const list = openEntry.list;

  // Reasons: tap to turn on, tap again to turn off.
  const chips = SETTINGS.REASONS[list].map((reason) => {
    const chip = button("chip", reason, () => {
      const i = entry.reasons.indexOf(reason);
      if (i === -1) entry.reasons.push(reason);
      else entry.reasons.splice(i, 1);
      saveData();
      renderCardExtras();
    });
    chip.setAttribute("aria-pressed", entry.reasons.includes(reason));
    return chip;
  });
  $("card-reasons").replaceChildren(...chips);

  // Strikes.
  $("strike-label").textContent = list === "add"
    ? `Stood out ${plural(entry.strikes, "time")}`
    : `Let me down ${plural(entry.strikes, "time")}`;
  $("strike-minus").disabled = entry.strikes <= 1;

  renderSwap(entry, list);
}

function renderSwap(entry, list) {
  const commander = currentCommander();
  const box = $("card-swap");
  const partner = entry.pairId && findEntry(commander, entry.pairId);

  if (partner) {
    const line = el("p", "swap-line");
    line.append(
      el("span", "", list === "add" ? "Goes in for " : "Comes out for "),
      button("link-button", partner.entry.card.name, () => openCardSheet(partner.list, partner.entry.id)),
      button("button button--plain button--small", "Unlink", () => {
        unlinkPair(entry);
        renderCardExtras();
      })
    );
    box.replaceChildren(line);
    return;
  }

  // No swap yet: list the cards from the other list to pick from.
  const choices = activeEntries(commander, otherList(list)).map((other) =>
    button("chip", other.card.name, () => {
      unlinkPair(other); // a card can only swap with one other card
      entry.pairId = other.id;
      other.pairId = entry.id;
      saveData();
      renderCardExtras();
    })
  );
  const hint = el("p", "muted", choices.length
    ? `Pair it with a card from ${LIST_TITLES[otherList(list)]}:`
    : `Add cards to ${LIST_TITLES[otherList(list)]} to pair them up as a swap.`);
  const chipBox = el("div", "chips");
  chipBox.append(...choices);
  box.replaceChildren(hint, chipBox);
}

// Break a swap pair from either side.
function unlinkPair(entry) {
  const partner = entry.pairId && findEntry(currentCommander(), entry.pairId);
  if (partner) partner.entry.pairId = null;
  entry.pairId = null;
  saveData();
}

function changeStrikes(amount) {
  const entry = findOpenEntry();
  entry.strikes = Math.max(1, entry.strikes + amount);
  saveData();
  renderCardExtras();
}

function renderPrices(card) {
  const rows = [
    ["US dollars", card.prices.usd, "$"],
    ["US dollars (foil)", card.prices.usd_foil, "$"],
    ["Euros", card.prices.eur, "€"],
    ["MTGO tickets", card.prices.tix, ""],
  ];
  const cells = [];
  rows.forEach(([label, value, symbol]) => {
    if (!value) return; // Scryfall leaves out prices it doesn't have
    cells.push(el("dt", "", label), el("dd", "", symbol + value + (symbol ? "" : " tix")));
  });
  if (cells.length === 0) cells.push(el("dt", "", "No prices listed"), el("dd", "", "—"));
  $("card-prices").replaceChildren(...cells);

  const links = [];
  Object.keys(STORE_NAMES).forEach((store) => {
    if (card.buyLinks[store]) links.push(buyLink(STORE_NAMES[store], card.buyLinks[store]));
  });
  if (card.scryfallUrl) links.push(buyLink("View on Scryfall", card.scryfallUrl));
  $("card-buy-links").replaceChildren(...links);
}

function buyLink(label, url) {
  const link = el("a", "buy-link");
  link.href = url;
  link.target = "_blank";      // open in a new tab
  link.rel = "noopener";
  link.append(el("span", "", label), el("span", "", "↗"));
  return link;
}

// Prices change every day, so fetch fresh ones each time a card is opened.
async function refreshPrices(entry) {
  try {
    entry.card = await fetchCardById(entry.card.scryfallId);
    saveData();
    if (findOpenEntry() === entry) {
      renderPrices(entry.card);
      $("price-status").textContent = "Today's prices from Scryfall.";
    }
  } catch (error) {
    if (findOpenEntry() === entry) {
      $("price-status").textContent = "Offline. Showing prices from when you saved this card.";
    }
  }
}

// "I made this change": move it (and its swap partner) into the history.
function markOpenCardDone() {
  const entry = findOpenEntry();
  const now = Date.now();
  entry.doneAt = now;
  const partner = entry.pairId && findEntry(currentCommander(), entry.pairId);
  if (partner) partner.entry.doneAt = now;
  saveData();
  $("sheet-card").close();
  toast(partner ? "Swap done. Both cards moved to History." : "Done. Moved to History.");
}

function moveOpenCard() {
  const entry = findOpenEntry();
  const commander = currentCommander();
  const from = openEntry.list;
  const to = otherList(from);

  // A swap pairs one add with one drop, so moving a card breaks its pair.
  unlinkPair(entry);
  commander[from] = commander[from].filter((e) => e !== entry);
  commander[to].unshift(entry);
  saveData();
  $("sheet-card").close();
}

function removeOpenCard() {
  const entry = findOpenEntry();
  if (!confirm(`Remove ${entry.card.name} from ${LIST_TITLES[openEntry.list]}?`)) return;

  const commander = currentCommander();
  unlinkPair(entry);
  commander[openEntry.list] = commander[openEntry.list].filter((e) => e !== entry);
  saveData();
  $("sheet-card").close();
}


/* =========================================================================
   9. THE HISTORY SHEET
   ========================================================================= */
function openHistory() {
  renderHistory();
  openSheet("sheet-history");
}

function renderHistory() {
  const commander = currentCommander();
  const done = [];
  ["add", "drop"].forEach((list) => {
    commander[list].forEach((entry) => {
      if (entry.doneAt) done.push({ entry, list });
    });
  });
  done.sort((a, b) => b.entry.doneAt - a.entry.doneAt); // newest first

  $("history-empty").hidden = done.length > 0;
  $("history-list").replaceChildren(...done.map(({ entry, list }) => {
    const item = el("li", "history-item");
    const words = el("div");
    const date = new Date(entry.doneAt).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    words.append(
      el("span", "history-item__name", (list === "add" ? "+ " : "− ") + entry.card.name),
      el("span", "history-item__meta", `${list === "add" ? "Added" : "Dropped"} · ${date}`)
    );
    item.append(words, button("button button--small", "Undo", () => {
      entry.doneAt = null;
      saveData();
      renderHistory();
      renderDeck();
    }));
    return item;
  }));
}


/* =========================================================================
   10. BACKUP AND RESTORE
   ========================================================================= */
function exportBackup() {
  const file = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const link = el("a");
  link.href = URL.createObjectURL(file);
  link.download = "commander-notes-backup-" + new Date().toISOString().slice(0, 10) + ".json";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  $("backup-status").textContent = "Backup saved. On iPhone, pick \"Save to Files\".";
}

async function importBackup(file) {
  try {
    const loaded = JSON.parse(await file.text());
    if (!isValidData(loaded)) throw new Error("not a backup");
    const count = loaded.commanders.length;
    if (!confirm(`Replace everything on this phone with this backup (${plural(count, "deck")})?`)) return;

    data = normalize(loaded);
    saveData();
    goHome();
    $("sheet-backup").close();
    toast(`Backup loaded: ${plural(count, "deck")}.`);
  } catch (error) {
    $("backup-status").textContent = "That file isn't a Commander Notes backup.";
  } finally {
    $("import-input").value = ""; // so picking the same file again still works
  }
}


/* =========================================================================
   11. WIRING THE BUTTONS UP
   ========================================================================= */
$("back-button").addEventListener("click", goHome);
$("open-history").addEventListener("click", openHistory);
$("delete-commander").addEventListener("click", deleteCurrentCommander);
$("copy-add").addEventListener("click", copyShoppingList);
$("quick-note").addEventListener("click", () => openSearch("quick"));
$("search-input").addEventListener("input", onSearchInput);
$("strike-plus").addEventListener("click", () => changeStrikes(1));
$("strike-minus").addEventListener("click", () => changeStrikes(-1));
$("done-card").addEventListener("click", markOpenCardDone);
$("move-card").addEventListener("click", moveOpenCard);
$("remove-card").addEventListener("click", removeOpenCard);
$("open-backup").addEventListener("click", () => {
  $("backup-status").textContent = "";
  openSheet("sheet-backup");
});
$("export-button").addEventListener("click", exportBackup);
$("import-input").addEventListener("change", (event) => {
  if (event.target.files[0]) importBackup(event.target.files[0]);
});

// Quick note: the To add / To drop switch.
document.querySelectorAll("[data-quick-list]").forEach((option) => {
  option.addEventListener("click", () => {
    searchTarget.list = option.dataset.quickList;
    renderQuickControls();
  });
});

// Save the note as you type.
$("card-note").addEventListener("input", () => {
  const entry = findOpenEntry();
  if (!entry) return;
  entry.note = $("card-note").value;
  saveData();
});

// When the card sheet closes, redraw the deck (moves, removals, badges).
$("sheet-card").addEventListener("close", () => {
  openEntry = null;
  renderDeck();
});

// The "+ Type a card…" lines on the deck screen.
document.querySelectorAll("[data-open-search]").forEach((field) => {
  field.addEventListener("click", () => openSearch(field.dataset.openSearch));
});

// "Cancel" / "Done" buttons, and tapping the dark area outside a sheet, close it.
document.querySelectorAll("dialog").forEach((dialog) => {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.querySelectorAll("[data-close-sheet]").forEach((closeButton) => {
    closeButton.addEventListener("click", () => dialog.close());
  });
});

// Make it work offline and open like an app (only over https or on this computer).
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

// Ask the phone to keep our saved notes even when storage runs low.
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

renderHome();
