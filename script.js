/* =========================================================================
   The Magic 100 — game logic
   Plain JavaScript, no libraries, no build step.

   How the file is organised:
     1. Settings you can tweak
     2. Small helpers
     3. Talking to the Scryfall API
     4. Building the card grid
     5. The timer
     6. Scoring and the results screen
     7. Wiring the buttons up
   ========================================================================= */


/* =========================================================================
   1. SETTINGS YOU CAN TWEAK
   These are the knobs. Change a number here to change how the game plays.
   ========================================================================= */
const SETTINGS = {
  // The dollar amount players are aiming for.
  TARGET_PRICE: 100,

  // How long a round lasts, in seconds. 180 = 3 minutes.
  ROUND_SECONDS: 180,

  // How many cards to show on screen.
  CARDS_ON_SCREEN: 100,

  // Only use cards priced inside this range (in US dollars).
  // A tighter range (say 0.50 to 15) makes the puzzle harder and more even.
  MIN_CARD_PRICE: 0.10,
  MAX_CARD_PRICE: 40,

  // How many random pages of search results to pull cards from.
  // More pages = more variety, but a slightly longer load.
  PAGES_TO_SAMPLE: 3,

  // The 100 cards on screen must be worth at least this many times the target,
  // so reaching $100 is not just possible but possible in several different
  // ways. At 1.0 a round could need nearly every card; 2.5 leaves real choice.
  MIN_POOL_MULTIPLE: 2.5,

  // Which Scryfall image size to use.
  // "normal" looks best. "small" loads roughly 10x faster — worth switching
  // to if the grid feels slow, especially on a phone.
  IMAGE_SIZE: "normal",

  // Points available. These two should add up to 100.
  MAX_ACCURACY_POINTS: 75,
  MAX_SPEED_POINTS: 25,

  // Scryfall asks for at least 100ms between requests. We use a little more
  // than that to stay comfortably inside their rules.
  REQUEST_GAP_MS: 120,

  // Give up on a request that stalls. Without this, anything that silently
  // swallows the request (a dropped connection, a blocking extension, a
  // sandboxed page) leaves the player staring at "Loading cards..." forever.
  REQUEST_TIMEOUT_MS: 10000,
};

// Scryfall constants — these describe the API, so leave them alone.
const SCRYFALL_SEARCH_URL = "https://api.scryfall.com/cards/search";
const SCRYFALL_CARDS_PER_PAGE = 175;


/* =========================================================================
   2. SMALL HELPERS
   ========================================================================= */

/** Shorthand for document.getElementById. */
function $(id) {
  return document.getElementById(id);
}

/** Pause for a number of milliseconds. Used to space out API requests. */
function sleep(milliseconds) {
  return new Promise(function (resolve) {
    setTimeout(resolve, milliseconds);
  });
}

/**
 * Shuffle an array in place (Fisher-Yates).
 * Walk backwards through the array, swapping each item with a random
 * earlier one. This is the standard, unbiased way to shuffle.
 */
function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = array[i];
    array[i] = array[j];
    array[j] = temp;
  }
  return array;
}

/** Turn 125 into "$125.00". */
function formatMoney(amount) {
  return "$" + amount.toFixed(2);
}

/** Turn 185 seconds into "3:05". */
function formatTime(totalSeconds) {
  const safeSeconds = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return minutes + ":" + String(seconds).padStart(2, "0");
}

/**
 * Money is awkward for computers: 0.1 + 0.2 is famously 0.30000000000000004.
 * Rounding to whole cents after adding keeps totals honest.
 */
function roundToCents(amount) {
  return Math.round(amount * 100) / 100;
}


/* =========================================================================
   THE GAME'S MEMORY
   Everything the game needs to remember while it runs lives in here.
   ========================================================================= */
const state = {
  cards: [],                 // the 100 cards currently on screen, in dealt order
  selectedIds: new Set(),    // the ids of the cards the player has clicked
  cardElements: {},          // card id -> its button on the page, for re-sorting
  sortKey: "random",         // which sort button is currently active
  sortDirection: 1,          // 1 = ascending, -1 = descending (ignored by "random")
  activeTypes: new Set(),    // card types the player is filtering down to; empty = show all
  roundEndsAt: 0,            // a timestamp (ms) for when the timer hits zero
  timerId: null,             // the id returned by setInterval, so we can stop it
  roundIsOver: false,        // guards against submitting twice
};

/** Show one screen and hide all the others. */
function showScreen(screenId) {
  const screens = document.querySelectorAll(".screen");
  screens.forEach(function (screen) {
    screen.classList.toggle("is-visible", screen.id === screenId);
  });
  window.scrollTo(0, 0);
}


/* =========================================================================
   3. TALKING TO THE SCRYFALL API
   Docs: https://scryfall.com/docs/api
   No API key is needed.
   ========================================================================= */

/**
 * Build a search URL for one page of results.
 *
 * The query asks for paper cards with a USD price inside our range, e.g.
 *   usd>=0.10 usd<=40 game:paper
 *
 * URLSearchParams handles escaping the spaces and the >= / <= characters,
 * so we never have to hand-encode the URL.
 */
function buildSearchUrl(page) {
  const query =
    "usd>=" + SETTINGS.MIN_CARD_PRICE +
    " usd<=" + SETTINGS.MAX_CARD_PRICE +
    " game:paper";

  const params = new URLSearchParams({
    q: query,
    unique: "cards",   // one printing per card, so we don't see the same card twice
    page: String(page),
  });

  return SCRYFALL_SEARCH_URL + "?" + params.toString();
}

/**
 * Fetch a single page of search results. Throws if anything goes wrong.
 *
 * An AbortController is the browser's way of cancelling a request. We start a
 * timer alongside the request; if the timer fires first it aborts the fetch,
 * so a stalled request fails with a clear message instead of hanging forever.
 */
async function fetchSearchPage(page) {
  const controller = new AbortController();
  const timeoutId = setTimeout(function () {
    controller.abort();
  }, SETTINGS.REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(buildSearchUrl(page), {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error("Scryfall responded with status " + response.status + ".");
    }

    const json = await response.json();

    // Scryfall can return a 200 with an error object inside it.
    if (json.object === "error") {
      throw new Error(json.details || "Scryfall returned an error.");
    }

    return json;
  } catch (error) {
    // Aborting makes fetch throw, so turn that into something readable.
    if (error && error.name === "AbortError") {
      const seconds = Math.max(1, Math.round(SETTINGS.REQUEST_TIMEOUT_MS / 1000));
      const timeout = new Error(
        "Scryfall didn't respond within " + seconds + " seconds."
      );
      // Keep the name so the code that shows the error screen can still tell
      // this was a connection problem rather than a bad response.
      timeout.name = "AbortError";
      throw timeout;
    }
    throw error;
  } finally {
    // Runs whether the request succeeded or failed, so the timer is never left
    // running and can't abort a later request by mistake.
    clearTimeout(timeoutId);
  }
}

/**
 * Read a card's US dollar price.
 * Returns a number, or null if this card has no usd price (which is common —
 * online-only and some promo printings have no paper price).
 */
function getCardPrice(card) {
  const raw = card.prices ? card.prices.usd : null;
  if (raw === null || raw === undefined) return null;

  const price = parseFloat(raw);
  return Number.isFinite(price) ? price : null;
}

/**
 * Read a card's image URL.
 * Most cards have image_uris. Double-faced cards (transform, modal DFCs)
 * don't — their images live on each face instead, so we use the front face.
 */
function getCardImage(card, size) {
  const wanted = size || SETTINGS.IMAGE_SIZE;

  if (card.image_uris && card.image_uris[wanted]) {
    return card.image_uris[wanted];
  }

  const frontFace = card.card_faces ? card.card_faces[0] : null;
  if (frontFace && frontFace.image_uris && frontFace.image_uris[wanted]) {
    return frontFace.image_uris[wanted];
  }

  return null;
}

/** Pick `howMany` different page numbers between 1 and `totalPages`. */
function pickRandomPages(totalPages, howMany) {
  const pages = new Set();

  // Never ask for more distinct pages than actually exist.
  const target = Math.min(howMany, totalPages);

  while (pages.size < target) {
    pages.add(Math.floor(Math.random() * totalPages) + 1);
  }

  return Array.from(pages);
}

/**
 * Load 100 random, usable cards.
 *
 * The plan:
 *   1. Ask for page 1 to find out how many cards match the search.
 *   2. Work out how many pages that is, and pick a few at random.
 *   3. Fetch those pages (pausing between requests).
 *   4. Throw away anything with no price or no image, and drop duplicates.
 *   5. Shuffle the pile and take the first 100.
 */
async function loadCards() {
  const firstPage = await fetchSearchPage(1);

  const totalCards = firstPage.total_cards || 0;
  if (totalCards === 0) {
    throw new Error("Scryfall found no cards matching that price range.");
  }

  const totalPages = Math.max(1, Math.ceil(totalCards / SCRYFALL_CARDS_PER_PAGE));
  const pagesToFetch = pickRandomPages(totalPages, SETTINGS.PAGES_TO_SAMPLE);

  // The pool of cards we'll eventually sample 100 from.
  const pool = [];
  const seenIds = new Set();
  const seenNames = new Set();

  /** Add every usable, not-yet-seen card from a page of results to the pool. */
  function addUsableCards(cardsFromApi) {
    if (!Array.isArray(cardsFromApi)) return;

    cardsFromApi.forEach(function (card) {
      const price = getCardPrice(card);
      const image = getCardImage(card);

      // Skip cards with no USD price or no usable image.
      if (price === null || image === null) return;

      // Skip anything we already have (same printing, or same card name).
      if (seenIds.has(card.id) || seenNames.has(card.name)) return;

      seenIds.add(card.id);
      seenNames.add(card.name);

      // Store a small, simple object instead of Scryfall's huge one.
      pool.push({
        id: card.id,
        name: card.name,
        price: price,
        image: image,
        // A second, smaller URL to try if the main image won't load.
        imageFallback: getCardImage(card, "small"),
        // Worked out once here so sorting later is just comparing numbers.
        colorRank: colorSortRank(card),
        year: releaseYear(card),
        rarityRank: raritySortRank(card),
        // Which of CARD_TYPES this card is (a card can be more than one,
        // e.g. an Artifact Creature), for the type filter chips.
        types: getCardTypes(card),
      });
    });
  }

  // Page 1 is already in hand, so use it rather than throwing it away.
  addUsableCards(firstPage.data);

  // Start each remaining request 120ms after the previous one, but DON'T wait
  // for one to finish before starting the next. The gap still respects
  // Scryfall's rate limit, while the requests themselves overlap -- so loading
  // takes about as long as the slowest request instead of the sum of them all.
  const pageRequests = pagesToFetch.map(async function (page, index) {
    await sleep((index + 1) * SETTINGS.REQUEST_GAP_MS);

    try {
      const json = await fetchSearchPage(page);
      return json.data;
    } catch (error) {
      // One bad page shouldn't ruin the round -- log it and carry on.
      console.warn("Skipping page " + page + ":", error);
      return [];
    }
  });

  // Promise.all waits for every request, but they ran side by side.
  const pagesOfCards = await Promise.all(pageRequests);
  pagesOfCards.forEach(addUsableCards);

  if (pool.length < SETTINGS.CARDS_ON_SCREEN) {
    throw new Error(
      "Only found " + pool.length + " priced cards, and we need " +
      SETTINGS.CARDS_ON_SCREEN + "."
    );
  }

  return chooseRoundCards(pool);
}

/**
 * Choose the cards for one round from the larger pool.
 *
 * A plain random 100 is usually fine, but an unlucky all-cheap draw could add
 * up to less than the target and deal a round nobody can win. So: take a
 * random 100, and if they are not collectively worth enough, trade the
 * cheapest of them for the most expensive cards left over until they are.
 */
function chooseRoundCards(pool) {
  shuffle(pool);

  const chosen = pool.slice(0, SETTINGS.CARDS_ON_SCREEN);
  const spares = pool.slice(SETTINGS.CARDS_ON_SCREEN);
  const floor = SETTINGS.TARGET_PRICE * SETTINGS.MIN_POOL_MULTIPLE;

  let total = chosen.reduce(function (sum, card) {
    return sum + card.price;
  }, 0);

  if (total >= floor) {
    return chosen;
  }

  // Line the cheapest chosen cards up against the priciest spares, then trade
  // one for one until the round is worth enough.
  chosen.sort(function (a, b) { return a.price - b.price; });
  spares.sort(function (a, b) { return b.price - a.price; });

  for (let i = 0; i < chosen.length && i < spares.length && total < floor; i++) {
    // Both lists are ordered, so once a trade stops helping, none of the
    // later ones would either.
    if (spares[i].price <= chosen[i].price) {
      break;
    }

    total += spares[i].price - chosen[i].price;
    chosen[i] = spares[i];
  }

  // IMPORTANT: shuffle again before handing these back. The lists above are
  // sorted by price, and showing the grid in price order would give away
  // every card's value at a glance.
  return shuffle(chosen);
}


/* -------------------------------------------------------------------------
   Reading the bits of a card we let players sort by.
   These run once per card while the round loads.
   ---------------------------------------------------------------------- */

// Magic's conventional colour order: White, Blue, Black, Red, Green.
const COLOR_ORDER = ["W", "U", "B", "R", "G"];

// Most to least rare. Odd rarities ("special", "bonus") fall to the end.
const RARITY_ORDER = ["mythic", "rare", "uncommon", "common"];

/** A card's colours. Double-faced cards keep theirs on the front face. */
function getCardColors(card) {
  if (Array.isArray(card.colors)) {
    return card.colors;
  }

  const frontFace = card.card_faces ? card.card_faces[0] : null;
  if (frontFace && Array.isArray(frontFace.colors)) {
    return frontFace.colors;
  }

  // Last resort: colour identity is always present.
  return Array.isArray(card.color_identity) ? card.color_identity : [];
}

/**
 * Sort position for colour: the five colours in WUBRG order (0-4), then every
 * multicolour card together (5), then colourless cards, artifacts and lands (6).
 */
function colorSortRank(card) {
  const colors = getCardColors(card);

  if (colors.length === 0) return 6;   // colourless, artifacts, lands
  if (colors.length > 1) return 5;     // all multicolour grouped together

  const position = COLOR_ORDER.indexOf(colors[0]);
  return position === -1 ? 6 : position;
}

/** The year a card was printed, from Scryfall's "2019-07-12" style date. */
function releaseYear(card) {
  const released = card.released_at;
  if (typeof released !== "string" || released.length < 4) {
    return 0;
  }

  const year = parseInt(released.slice(0, 4), 10);
  return Number.isFinite(year) ? year : 0;
}

/** Sort position for rarity: mythic first, common last. */
function raritySortRank(card) {
  const position = RARITY_ORDER.indexOf(card.rarity);
  return position === -1 ? RARITY_ORDER.length : position;
}

// The card types players can filter by.
const CARD_TYPES = [
  "Creature", "Planeswalker", "Instant", "Sorcery",
  "Enchantment", "Artifact", "Land", "Battle",
];

/**
 * Which of CARD_TYPES a card is.
 * Scryfall's type_line looks like "Artifact Creature — Construct" or
 * "Legendary Enchantment — God". We only care about the words before the
 * "—", and before any "//" on a split card. A card can match more than one
 * type (an Artifact Creature matches both).
 */
function getCardTypes(card) {
  const line = card.type_line ||
    (card.card_faces && card.card_faces[0] && card.card_faces[0].type_line) ||
    "";

  const mainTypes = line.split("//")[0].split("—")[0].trim();
  const words = mainTypes.split(/\s+/);

  return CARD_TYPES.filter(function (type) {
    return words.includes(type);
  });
}


/* =========================================================================
   4. BUILDING THE CARD GRID
   ========================================================================= */

/** Draw all 100 cards as clickable buttons. */
function renderCardGrid() {
  const grid = $("card-grid");
  grid.innerHTML = "";
  state.cardElements = {};

  // A DocumentFragment lets us build all 100 buttons off-screen and insert
  // them in one go, which is much faster than adding them one at a time.
  const fragment = document.createDocumentFragment();

  state.cards.forEach(function (card) {
    // A real <button> means keyboard and screen readers work for free.
    const button = document.createElement("button");
    button.type = "button";
    button.className = "card";
    button.dataset.cardId = card.id;
    button.setAttribute("aria-pressed", "false");
    button.setAttribute("aria-label", card.name);

    const image = document.createElement("img");
    image.src = card.image;
    image.alt = card.name;
    image.loading = "lazy";      // don't download images until they scroll into view
    image.decoding = "async";
    image.draggable = false;

    // If the picture won't load, try the smaller version once, and if that
    // fails too show the card's name. A named box is still playable; an empty
    // box is not.
    let triedFallback = false;
    image.addEventListener("error", function () {
      if (!triedFallback && card.imageFallback && card.imageFallback !== card.image) {
        triedFallback = true;
        image.src = card.imageFallback;
        return;
      }

      image.remove();
      button.classList.add("card--no-image");

      const label = document.createElement("span");
      label.className = "card__name";
      label.textContent = card.name;
      button.appendChild(label);
    });

    button.appendChild(image);
    fragment.appendChild(button);

    // Keep a handle on the button so sorting can move it without rebuilding
    // it (rebuilding would re-download every image).
    state.cardElements[card.id] = button;
  });

  grid.appendChild(fragment);
}

/**
 * Select or unselect a card.
 * Note we never show the running dollar total — that would give the prices away.
 */
function toggleCard(button) {
  if (state.roundIsOver) return;

  const cardId = button.dataset.cardId;

  if (state.selectedIds.has(cardId)) {
    state.selectedIds.delete(cardId);
    button.classList.remove("is-selected");
    button.setAttribute("aria-pressed", "false");
  } else {
    state.selectedIds.add(cardId);
    button.classList.add("is-selected");
    button.setAttribute("aria-pressed", "true");
  }

  $("selected-count").textContent = String(state.selectedIds.size);
}

/**
 * Show a card full-size, so its rules text is actually readable.
 * Reuses the image already loaded in the grid -- no extra network request.
 */
function openCardPreview(card) {
  $("card-preview-image").src = card.image;
  $("card-preview-image").alt = card.name;
  $("card-preview").hidden = false;
}

function closeCardPreview() {
  $("card-preview").hidden = true;
  $("card-preview-image").src = "";
}


/* -------------------------------------------------------------------------
   Sorting the grid.

   Sorting only moves cards around. It never changes which cards you were
   dealt, and it never touches what you have already selected.
   ---------------------------------------------------------------------- */

// How each button orders the grid, always written ascending. "random" has no
// comparison because it means "leave them in the order they were dealt".
// state.sortDirection flips the result for descending order.
const SORTS = {
  random: null,
  color: function (a, b) { return a.colorRank - b.colorRank; },
  year: function (a, b) { return a.year - b.year; },
  rarity: function (a, b) { return a.rarityRank - b.rarityRank; },
};

// Which direction each sort opens in on its first click, so the default feel
// stays the same as before direction toggling existed (newest year first,
// rarest first, WUBRG order first).
const DEFAULT_DIRECTIONS = {
  color: 1,
  year: -1,
  rarity: 1,
};

/** The round's cards in the order a given button wants them. */
function sortedCards(sortKey) {
  // Copy first: state.cards must keep the dealt order so Shuffle can restore it.
  const cards = state.cards.slice();

  const compare = SORTS[sortKey];
  if (!compare) {
    return cards;
  }

  // Sorting in JavaScript is stable, so cards that tie (same colour, same year,
  // same rarity) stay in their dealt order -- which is random.
  //
  // Never add price as a tie-breaker here. It would line the grid up by value
  // and hand the player every answer.
  const direction = state.sortDirection;
  return cards.sort(function (a, b) { return compare(a, b) * direction; });
}

/**
 * Re-order the grid to match the chosen sort.
 * Clicking the sort that's already active flips its direction instead of
 * doing nothing; clicking a different one activates it at its default
 * direction.
 */
function applySort(sortKey) {
  if (!Object.prototype.hasOwnProperty.call(SORTS, sortKey)) {
    return;
  }

  if (sortKey === state.sortKey && sortKey !== "random") {
    state.sortDirection *= -1;
  } else {
    state.sortKey = sortKey;
    state.sortDirection = DEFAULT_DIRECTIONS[sortKey] || 1;
  }

  const grid = $("card-grid");
  const fragment = document.createDocumentFragment();

  // Appending an element that is already on the page MOVES it rather than
  // copying it. So the same buttons get rearranged: images don't reload, and
  // anything already selected stays selected.
  sortedCards(sortKey).forEach(function (card) {
    const button = state.cardElements[card.id];
    if (button) {
      fragment.appendChild(button);
    }
  });

  grid.appendChild(fragment);
  updateSortButtons();
}

/** Highlight whichever sort is currently in use, and draw its arrow. */
function updateSortButtons() {
  const buttons = document.querySelectorAll(".sort-button");

  buttons.forEach(function (button) {
    const isActive = button.dataset.sort === state.sortKey;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", isActive ? "true" : "false");

    const arrow = button.querySelector(".sort-button__arrow");
    if (arrow) {
      arrow.textContent = isActive
        ? (state.sortDirection === 1 ? "▲" : "▼")
        : "";
    }
  });
}

/**
 * Show or hide cards by type.
 * An empty state.activeTypes means "no filter", so every card is shown.
 * Otherwise a card stays visible if it matches ANY selected type.
 * This only toggles a class, the same way applySort only reorders -- it
 * never touches selection state or rebuilds a single card.
 */
function applyFilters() {
  state.cards.forEach(function (card) {
    const button = state.cardElements[card.id];
    if (!button) return;

    const matches = state.activeTypes.size === 0 ||
      card.types.some(function (type) { return state.activeTypes.has(type); });

    button.classList.toggle("is-hidden", !matches);
  });
}

/** Clear every filter chip back to off. */
function resetFilterChips() {
  state.activeTypes.clear();

  document.querySelectorAll(".filter-chip").forEach(function (chip) {
    chip.classList.remove("is-active");
    chip.setAttribute("aria-pressed", "false");
  });
}


/* =========================================================================
   5. THE TIMER
   ========================================================================= */

/**
 * How many seconds are left, as a precise decimal.
 * We work this out from the clock rather than counting ticks, because
 * setInterval drifts — a background tab can slow it down a lot.
 */
function secondsRemaining() {
  const raw = (state.roundEndsAt - Date.now()) / 1000;
  return Math.max(0, Math.min(SETTINGS.ROUND_SECONDS, raw));
}

/** Redraw the clock, and auto-submit when it runs out. */
function updateTimer() {
  const left = secondsRemaining();
  const timerElement = $("timer");

  timerElement.textContent = formatTime(Math.ceil(left));
  timerElement.classList.toggle("is-low", left <= 30);

  if (left <= 0) {
    submitRound();
  }
}

function startTimer() {
  state.roundEndsAt = Date.now() + SETTINGS.ROUND_SECONDS * 1000;
  updateTimer();

  // Checking 5x a second keeps the "0:00" moment feeling instant.
  state.timerId = setInterval(updateTimer, 200);
}

function stopTimer() {
  if (state.timerId !== null) {
    clearInterval(state.timerId);
    state.timerId = null;
  }
}


/* =========================================================================
   6. SCORING AND THE RESULTS SCREEN
   ========================================================================= */

/**
 * Work out the score, out of 100.
 *
 *   Accuracy (up to 75): 75 x max(0, 1 - |total - 100| / 100)
 *     Being $20 over and $20 under score exactly the same.
 *     Miss by $100 or more and accuracy is 0.
 *
 *   Speed (up to 25): 25 x (seconds left / round length)
 *     Only awarded if accuracy is above 0, so instantly submitting
 *     nothing scores nothing.
 */
function calculateScore(total, secondsLeft) {
  const difference = Math.abs(total - SETTINGS.TARGET_PRICE);

  const accuracyFraction = Math.max(0, 1 - difference / SETTINGS.TARGET_PRICE);
  const accuracyPoints = SETTINGS.MAX_ACCURACY_POINTS * accuracyFraction;

  const speedPoints = accuracyPoints > 0
    ? SETTINGS.MAX_SPEED_POINTS * (secondsLeft / SETTINGS.ROUND_SECONDS)
    : 0;

  const total100 = accuracyPoints + speedPoints;

  return {
    accuracy: Math.round(accuracyPoints * 10) / 10,
    speed: Math.round(speedPoints * 10) / 10,
    // Rounded to one decimal place, as a number.
    final: Math.round(total100 * 10) / 10,
  };
}

/** End the round: stop the clock, add up the picks, and show the results. */
function submitRound() {
  if (state.roundIsOver) return;   // never run twice
  state.roundIsOver = true;

  const secondsLeft = secondsRemaining();
  stopTimer();

  // Find the full card objects for everything the player selected.
  const picks = state.cards.filter(function (card) {
    return state.selectedIds.has(card.id);
  });

  const total = roundToCents(
    picks.reduce(function (sum, card) {
      return sum + card.price;
    }, 0)
  );

  const score = calculateScore(total, secondsLeft);
  const secondsUsed = SETTINGS.ROUND_SECONDS - secondsLeft;

  showResults(picks, total, score, secondsUsed);
}

/** Fill in and show the results screen. */
function showResults(picks, total, score, secondsUsed) {
  $("final-score").textContent = score.final.toFixed(1);

  $("stat-total").textContent = formatMoney(total);
  $("stat-target").textContent = formatMoney(SETTINGS.TARGET_PRICE);

  const difference = roundToCents(Math.abs(total - SETTINGS.TARGET_PRICE));
  const overOrUnder = total > SETTINGS.TARGET_PRICE ? " over" : " under";
  $("stat-difference").textContent =
    difference === 0 ? "Exactly $100.00" : formatMoney(difference) + overOrUnder;

  $("stat-time").textContent = formatTime(secondsUsed);
  $("stat-picked").textContent = String(picks.length);
  $("stat-breakdown").textContent =
    score.accuracy.toFixed(1) + " accuracy + " + score.speed.toFixed(1) + " speed";

  // Reveal every picked card with its price, most expensive first.
  const picksGrid = $("picks-grid");
  picksGrid.innerHTML = "";

  if (picks.length === 0) {
    const note = document.createElement("p");
    note.className = "empty-note";
    note.textContent = "You didn't pick any cards.";
    picksGrid.appendChild(note);
  } else {
    // slice() copies the array first so we don't reorder the original.
    const sorted = picks.slice().sort(function (a, b) {
      return b.price - a.price;
    });

    const fragment = document.createDocumentFragment();

    sorted.forEach(function (card) {
      const figure = document.createElement("figure");
      figure.className = "pick";
      figure.style.margin = "0";

      const image = document.createElement("img");
      image.src = card.image;
      image.alt = card.name;
      image.loading = "lazy";
      image.decoding = "async";

      const caption = document.createElement("figcaption");
      caption.className = "pick__price";
      caption.textContent = formatMoney(card.price);

      figure.appendChild(image);
      figure.appendChild(caption);
      fragment.appendChild(figure);
    });

    picksGrid.appendChild(fragment);
  }

  showScreen("screen-results");
}


/* =========================================================================
   7. WIRING THE BUTTONS UP
   ========================================================================= */

/** Load a fresh set of cards and start a new round. */
async function startGame() {
  // Reset everything from any previous round.
  stopTimer();
  state.cards = [];
  state.selectedIds.clear();
  state.cardElements = {};
  state.sortKey = "random";
  state.sortDirection = 1;
  state.roundIsOver = false;
  $("selected-count").textContent = "0";
  updateSortButtons();
  resetFilterChips();
  closeCardPreview();

  showScreen("screen-loading");

  try {
    state.cards = await loadCards();
  } catch (error) {
    console.error(error);

    // fetch() throws a TypeError when the request never reaches the network.
    // That means offline, but it also means "something blocked it" -- a browser
    // extension, a network policy, or a sandboxed page that isn't allowed to
    // call out. Those look identical from here, so the advice covers both.
    const couldNotReachScryfall =
      Boolean(error) && (error.name === "TypeError" || error.name === "AbortError");

    let detail = error && error.message ? error.message : "Something went wrong.";
    if (!/[.!?]$/.test(detail)) detail += ".";

    $("error-message").textContent = detail + " " +
      (couldNotReachScryfall
        ? "You may be offline, or something may be blocking the request to Scryfall."
        : "Please try again in a moment.");

    showScreen("screen-error");
    return;
  }

  renderCardGrid();
  showScreen("screen-game");
  startTimer();   // the clock only starts once the cards are actually on screen
}

$("start-button").addEventListener("click", startGame);
$("retry-button").addEventListener("click", startGame);
$("play-again-button").addEventListener("click", startGame);
$("submit-button").addEventListener("click", submitRound);

/**
 * One click listener on the whole grid instead of 100 separate ones.
 * This is called "event delegation": the click bubbles up from the card
 * to the grid, and we work out which card it came from.
 */
// One listener per sort button. They sit in the bar above the grid.
document.querySelectorAll(".sort-button").forEach(function (button) {
  button.addEventListener("click", function () {
    applySort(button.dataset.sort);
  });
});

// One listener per filter chip. Multiple can be active at once -- a card
// stays visible if it matches any of them.
document.querySelectorAll(".filter-chip").forEach(function (chip) {
  chip.addEventListener("click", function () {
    const type = chip.dataset.type;

    if (state.activeTypes.has(type)) {
      state.activeTypes.delete(type);
      chip.classList.remove("is-active");
      chip.setAttribute("aria-pressed", "false");
    } else {
      state.activeTypes.add(type);
      chip.classList.add("is-active");
      chip.setAttribute("aria-pressed", "true");
    }

    applyFilters();
  });
});

$("card-grid").addEventListener("click", function (event) {
  const button = event.target.closest(".card");
  if (button) {
    toggleCard(button);
  }
});

// Double-click (or double-tap) a card to see it full-size. A real
// double-click fires two ordinary clicks first, so toggleCard() runs twice
// from the same gesture -- selection flips on, then off again, netting back
// to where it started.
$("card-grid").addEventListener("dblclick", function (event) {
  const button = event.target.closest(".card");
  if (!button) return;

  const card = state.cards.find(function (c) { return c.id === button.dataset.cardId; });
  if (card) {
    openCardPreview(card);
  }
});

$("card-preview-close").addEventListener("click", closeCardPreview);

// Clicking the dark backdrop (but not the card image itself) closes it too.
$("card-preview").addEventListener("click", function (event) {
  if (event.target === event.currentTarget) {
    closeCardPreview();
  }
});

document.addEventListener("keydown", function (event) {
  if (event.key === "Escape" && !$("card-preview").hidden) {
    closeCardPreview();
  }
});
