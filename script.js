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
  cards: [],                 // the 100 cards currently on screen
  selectedIds: new Set(),    // the ids of the cards the player has clicked
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

/** Fetch a single page of search results. Throws if anything goes wrong. */
async function fetchSearchPage(page) {
  const response = await fetch(buildSearchUrl(page), {
    headers: { Accept: "application/json" },
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
function getCardImage(card) {
  if (card.image_uris && card.image_uris[SETTINGS.IMAGE_SIZE]) {
    return card.image_uris[SETTINGS.IMAGE_SIZE];
  }

  const frontFace = card.card_faces ? card.card_faces[0] : null;
  if (frontFace && frontFace.image_uris && frontFace.image_uris[SETTINGS.IMAGE_SIZE]) {
    return frontFace.image_uris[SETTINGS.IMAGE_SIZE];
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
      });
    });
  }

  for (const page of pagesToFetch) {
    // Scryfall's rate limit: wait between requests.
    await sleep(SETTINGS.REQUEST_GAP_MS);

    try {
      const json = await fetchSearchPage(page);
      addUsableCards(json.data);
    } catch (error) {
      // One bad page shouldn't ruin the round — log it and carry on.
      console.warn("Skipping page " + page + ":", error);
    }
  }

  // If the random pages came up short, top the pool up from page 1.
  if (pool.length < SETTINGS.CARDS_ON_SCREEN) {
    addUsableCards(firstPage.data);
  }

  if (pool.length < SETTINGS.CARDS_ON_SCREEN) {
    throw new Error(
      "Only found " + pool.length + " priced cards, and we need " +
      SETTINGS.CARDS_ON_SCREEN + "."
    );
  }

  shuffle(pool);
  return pool.slice(0, SETTINGS.CARDS_ON_SCREEN);
}


/* =========================================================================
   4. BUILDING THE CARD GRID
   ========================================================================= */

/** Draw all 100 cards as clickable buttons. */
function renderCardGrid() {
  const grid = $("card-grid");
  grid.innerHTML = "";

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
    image.alt = card.name;       // shown if the image fails to load
    image.loading = "lazy";      // don't download images until they scroll into view
    image.decoding = "async";
    image.draggable = false;

    button.appendChild(image);
    fragment.appendChild(button);
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
  state.roundIsOver = false;
  $("selected-count").textContent = "0";

  showScreen("screen-loading");

  try {
    state.cards = await loadCards();
  } catch (error) {
    console.error(error);

    // fetch() throws a TypeError when the browser can't reach the network at
    // all, so that's the one case where "check your connection" is useful advice.
    const isNetworkProblem = Boolean(error) && error.name === "TypeError";

    let detail = error && error.message ? error.message : "Something went wrong.";
    if (!/[.!?]$/.test(detail)) detail += ".";

    $("error-message").textContent = detail + " " +
      (isNetworkProblem
        ? "Check your internet connection and try again."
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
$("card-grid").addEventListener("click", function (event) {
  const button = event.target.closest(".card");
  if (button) {
    toggleCard(button);
  }
});
