/* =========================================================================
   Commander Notes — app logic
   Plain JavaScript, no libraries, no build step.

   How the file is organised:
     1. Settings you can tweak
     2. Saving and loading (your notes live on this device)
     3. Small helpers
     4. Talking to the Scryfall API
     5. Home screen: the commander carousel
     6. Deck screen: cards to add / cards to drop
     7. The search sheet (adding commanders and cards)
     8. The card sheet (prices, where to buy, your note)
     9. Wiring the buttons up

   How the saved data is shaped:
     {
       commanders: [
         {
           id, card,             // card = the details we got from Scryfall
           add:  [ { id, card, note } ],
           drop: [ { id, card, note } ]
         }
       ]
     }
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
    if (saved && Array.isArray(saved.commanders)) return saved;
  } catch (error) {
    // Missing or unreadable data: start with an empty notepad.
  }
  return { commanders: [] };
}

function saveData() {
  try {
    localStorage.setItem(SETTINGS.STORAGE_KEY, JSON.stringify(data));
  } catch (error) {
    console.warn("Could not save your notes:", error);
  }
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

function currentCommander() {
  return data.commanders.find((commander) => commander.id === currentCommanderId);
}

function showScreen(id) {
  document.querySelectorAll(".screen").forEach((screen) => {
    screen.classList.toggle("is-visible", screen.id === id);
  });
  window.scrollTo(0, 0);
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


/* =========================================================================
   4. TALKING TO THE SCRYFALL API
   Scryfall is a free Magic card database. Docs: https://scryfall.com/docs/api
   ========================================================================= */
const SCRYFALL = "https://api.scryfall.com";

async function scryfallGet(path) {
  const response = await fetch(SCRYFALL + path);
  if (!response.ok) throw new Error("Scryfall replied with " + response.status);
  return response.json();
}

// Card names that match what has been typed so far.
async function fetchSuggestions(text) {
  const result = await scryfallGet("/cards/autocomplete?q=" + encodeURIComponent(text));
  return result.data.slice(0, SETTINGS.MAX_SUGGESTIONS);
}

async function fetchCardByName(name) {
  return cardFromScryfall(await scryfallGet("/cards/named?exact=" + encodeURIComponent(name)));
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
    const tile = el("button", "commander-tile");
    tile.type = "button";
    tile.append(
      cardImage(commander.card),
      el("span", "commander-tile__name", commander.card.name),
      el("span", "commander-tile__counts", `${commander.add.length} to add · ${commander.drop.length} to drop`)
    );
    tile.addEventListener("click", () => openDeck(commander.id));
    carousel.append(tile);
  });

  // The last tile is always "+ Add a commander".
  const addTile = el("button", "commander-tile");
  addTile.type = "button";
  addTile.append(
    el("span", "commander-tile__blank", "+"),
    el("span", "commander-tile__name", "Add a commander")
  );
  addTile.addEventListener("click", () => openSearch("commander"));
  carousel.append(addTile);

  $("home-hint").textContent = data.commanders.length
    ? "Swipe to see all your decks →"
    : "Tap the + to add your first commander.";
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
  renderDeck();
  showScreen("screen-deck");
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
}

function renderRow(list) {
  const entries = currentCommander()[list];
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
    const button = el("button", "row-card");
    button.type = "button";
    button.append(cardImage(entry.card));
    if (entry.note) button.append(el("span", "row-card__note-flag", "✎"));
    button.addEventListener("click", () => openCardSheet(list, entry.id));
    row.append(button);
  });
}

function addCardToList(list, card) {
  const commander = currentCommander();
  const otherList = list === "add" ? "drop" : "add";

  if (commander[list].some((entry) => entry.card.name === card.name)) {
    setSearchStatus(`${card.name} is already in ${LIST_TITLES[list]}.`);
    return false;
  }
  if (commander[otherList].some((entry) => entry.card.name === card.name)) {
    setSearchStatus(`${card.name} is in ${LIST_TITLES[otherList]}. Tap it there to move it.`);
    return false;
  }

  // New cards go at the front so the latest note is the first one you see.
  commander[list].unshift({ id: makeId(), card, note: "" });
  saveData();
  renderRow(list);
  $("row-" + list).scrollTo({ left: 0, behavior: "smooth" });
  return true;
}

function deleteCurrentCommander() {
  const commander = currentCommander();
  if (!commander) return;
  if (!confirm(`Delete ${commander.card.name} and all its notes?`)) return;

  data.commanders = data.commanders.filter((c) => c.id !== commander.id);
  saveData();
  goHome();
}

function goHome() {
  renderHome();
  showScreen("screen-home");
}


/* =========================================================================
   7. THE SEARCH SHEET
   One pop-up does three jobs, depending on searchMode:
     "commander" → add a new commander to the carousel
     "add"       → add a card to "Cards to add"
     "drop"      → add a card to "Cards to drop"
   ========================================================================= */
let searchMode = null;
let searchTimer = null;
// Every search gets a number. If an older, slower reply arrives after a
// newer search has started, we can spot it and ignore it.
let searchNumber = 0;
let isPicking = false;

function openSearch(mode) {
  searchMode = mode;
  $("search-title").textContent = mode === "commander" ? "Add a commander" : "Add to " + LIST_TITLES[mode];
  $("search-input").value = "";
  $("search-results").replaceChildren();
  setSearchStatus("");
  $("sheet-search").showModal();
  $("search-input").focus();
}

function setSearchStatus(message) {
  $("search-status").textContent = message;
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

async function runSearch(text) {
  const myNumber = ++searchNumber;
  setSearchStatus("Searching…");

  try {
    const names = await fetchSuggestions(text);
    if (myNumber !== searchNumber) return; // a newer search has started
    renderSuggestions(names);
    setSearchStatus(names.length ? "" : "No cards found.");
  } catch (error) {
    if (myNumber !== searchNumber) return;
    setSearchStatus("Couldn't reach Scryfall. Check your connection.");
  }
}

function renderSuggestions(names) {
  const items = names.map((name) => {
    const item = el("li");
    const button = el("button", "", name);
    button.type = "button";
    button.addEventListener("click", () => pickCard(name));
    item.append(button);
    return item;
  });
  $("search-results").replaceChildren(...items);
}

async function pickCard(name) {
  if (isPicking) return; // ignore double taps
  isPicking = true;
  searchNumber++;        // ignore any search still on its way
  setSearchStatus(`Loading ${name}…`);

  try {
    const card = await fetchCardByName(name);
    const added = searchMode === "commander" ? addCommander(card) : addCardToList(searchMode, card);
    if (added) $("sheet-search").close();
  } catch (error) {
    setSearchStatus("Couldn't load that card. Try again.");
  } finally {
    isPicking = false;
  }
}


/* =========================================================================
   8. THE CARD SHEET
   Shows the card big, its prices, links to buy it, and your note.
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
  $("move-card").textContent = "Move to " + LIST_TITLES[list === "add" ? "drop" : "add"];
  renderPrices(card);
  $("price-status").textContent = "Checking today's prices…";

  $("sheet-card").showModal();
  refreshPrices(entry);
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

function moveOpenCard() {
  const entry = findOpenEntry();
  const commander = currentCommander();
  const from = openEntry.list;
  const to = from === "add" ? "drop" : "add";

  commander[from] = commander[from].filter((e) => e !== entry);
  commander[to].unshift(entry);
  saveData();
  $("sheet-card").close();
}

function removeOpenCard() {
  const entry = findOpenEntry();
  if (!confirm(`Remove ${entry.card.name} from ${LIST_TITLES[openEntry.list]}?`)) return;

  const commander = currentCommander();
  commander[openEntry.list] = commander[openEntry.list].filter((e) => e !== entry);
  saveData();
  $("sheet-card").close();
}


/* =========================================================================
   9. WIRING THE BUTTONS UP
   ========================================================================= */
$("back-button").addEventListener("click", goHome);
$("delete-commander").addEventListener("click", deleteCurrentCommander);
$("search-input").addEventListener("input", onSearchInput);
$("move-card").addEventListener("click", moveOpenCard);
$("remove-card").addEventListener("click", removeOpenCard);

// Save the note as you type.
$("card-note").addEventListener("input", () => {
  const entry = findOpenEntry();
  if (!entry) return;
  entry.note = $("card-note").value;
  saveData();
});

// When the card sheet closes, redraw the rows (moves, removals, note badges).
$("sheet-card").addEventListener("close", () => {
  openEntry = null;
  renderDeck();
});

// The "+ Add" buttons on the deck screen.
document.querySelectorAll("[data-open-search]").forEach((button) => {
  button.addEventListener("click", () => openSearch(button.dataset.openSearch));
});

// "Cancel" / "Done" buttons, and tapping the dark area outside a sheet, close it.
document.querySelectorAll("dialog").forEach((dialog) => {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.querySelectorAll("[data-close-sheet]").forEach((button) => {
    button.addEventListener("click", () => dialog.close());
  });
});

renderHome();
