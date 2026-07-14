function formatDate(value) {
  if (!value) return "Datum neznámý";
  try {
    return new Date(value).toLocaleString("cs-CZ", {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return value;
  }
}

function el(id) {
  return document.getElementById(id);
}

const listEl = el("list");
const metaEl = el("meta");
const searchEl = el("search");
const dayEl = el("day-filter");
const categoryEl = el("category-filter");
const speedEl = el("speed-control");
const template = el("card-template");

const FULL_DATA_URL = "data/articles.json";
const LATEST_DATA_URL = "data/latest.json";
const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 200;

let allArticles = [];
let filteredArticles = [];
let visibleCount = PAGE_SIZE;
let archiveLoaded = false;
let latestDay = null;
let totalArticleCount = 0;
let playbackRate = Number(localStorage.getItem("preferredPlaybackRate") || "1");

const audioObserver = "IntersectionObserver" in window
  ? new IntersectionObserver((entries, observer) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        setAudioSource(entry.target);
        observer.unobserve(entry.target);
      });
    }, { rootMargin: "400px 0px" })
  : null;

function createOption(value, label) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  return option;
}

function debounce(fn, delay) {
  let timerId;
  return (...args) => {
    window.clearTimeout(timerId);
    timerId = window.setTimeout(() => fn(...args), delay);
  };
}

function fillSelect(selectEl, values, defaultLabel) {
  selectEl.innerHTML = "";
  selectEl.appendChild(createOption("", defaultLabel));
  values.forEach((value) => selectEl.appendChild(createOption(value, value)));
}

function applyPlaybackRate(audio, labelEl) {
  audio.playbackRate = playbackRate;
  if (labelEl) labelEl.textContent = `${playbackRate}×`;
}

function syncAllPlaybackRates() {
  document.querySelectorAll(".card").forEach((card) => {
    const audio = card.querySelector("audio");
    const label = card.querySelector(".speed-value");
    if (audio) applyPlaybackRate(audio, label);
  });
  if (speedEl) speedEl.value = String(playbackRate);
}

function setAudioSource(audio) {
  if (!audio.src && audio.dataset.src) {
    audio.src = audio.dataset.src;
  }
}

function updateMeta() {
  const generatedAt = metaEl.dataset.generatedAtText || "";
  const filteredCount = filteredArticles.length;
  const shownCount = Math.min(filteredCount, visibleCount);
  const total = totalArticleCount || allArticles.length;
  const loadingMode = archiveLoaded ? "" : " · Načten nejnovější den";

  metaEl.dataset.filteredCount = String(filteredCount);
  metaEl.textContent = `${generatedAt} · Zobrazeno: ${shownCount} z ${filteredCount} vyfiltrovaných · Celkem: ${total}${loadingMode}`;
}

const ALLOWED_LINK_HOSTS = new Set(["denikn.cz", "www.denikn.cz"]);
const ALLOWED_MEDIA_HOSTS = new Set(["static.novydenik.com"]);

function safeUrl(value, allowedHosts) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    if (!allowedHosts.has(url.hostname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function showError(message, detail) {
  metaEl.textContent = message;
  listEl.innerHTML = "";

  const empty = document.createElement("div");
  empty.className = "empty";
  empty.textContent = detail;
  listEl.appendChild(empty);
}

function runFilter() {
  applyFilter().catch((error) => {
    showError("Nepodařilo se filtrovat články.", error.message);
  });
}

function createShowMoreButton(totalCount) {
  const remaining = totalCount - visibleCount;
  const button = document.createElement("button");

  button.type = "button";
  button.className = "show-more";
  button.textContent = `Zobrazit dalších ${Math.min(PAGE_SIZE, remaining)} (${remaining} zbývá)`;
  button.addEventListener("click", () => {
    visibleCount += PAGE_SIZE;
    updateMeta();
    render(filteredArticles);
    syncAllPlaybackRates();
  });

  return button;
}

function render(items) {
  if (audioObserver) {
    listEl.querySelectorAll("audio").forEach((audio) => audioObserver.unobserve(audio));
  }

  listEl.innerHTML = "";

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Pro tento filtr nebyly nalezeny žádné články.";
    listEl.appendChild(empty);
    return;
  }

  const visibleItems = items.slice(0, visibleCount);
  const fragment = document.createDocumentFragment();

  for (const item of visibleItems) {
    const node = template.content.cloneNode(true);
    node.querySelector(".title").textContent = item.title || item.url || "Bez názvu";

    const categoryText = Array.isArray(item.categories) && item.categories.length
      ? item.categories.join(", ")
      : "Bez kategorie";
    node.querySelector(".details").textContent = `Publikováno: ${formatDate(item.published)} · Kategorie: ${categoryText}`;

    const articleUrl = safeUrl(item.url, ALLOWED_LINK_HOSTS);
    const mp3Url = safeUrl(item.mp3_url, ALLOWED_MEDIA_HOSTS);

    const articleLink = node.querySelector(".article-link");
    if (articleUrl) {
      articleLink.href = articleUrl;
    } else {
      articleLink.remove();
    }

    const mp3Link = node.querySelector(".mp3-link");
    if (mp3Url) {
      mp3Link.href = mp3Url;
    } else {
      mp3Link.remove();
    }

    const audio = node.querySelector("audio");
    if (mp3Url) {
      audio.dataset.src = mp3Url;
    }
    audio.preload = "none";
    const speedValueEl = node.querySelector(".speed-value");
    applyPlaybackRate(audio, speedValueEl);
    audio.addEventListener("pointerdown", () => setAudioSource(audio), { once: true });
    audio.addEventListener("focus", () => setAudioSource(audio), { once: true });
    audio.addEventListener("keydown", () => setAudioSource(audio), { once: true });
    audio.addEventListener("loadedmetadata", () => applyPlaybackRate(audio, speedValueEl));
    audio.addEventListener("play", () => {
      setAudioSource(audio);
      applyPlaybackRate(audio, speedValueEl);
    });

    if (audioObserver) {
      audioObserver.observe(audio);
    } else {
      setAudioSource(audio);
    }

    const chipsEl = node.querySelector(".chips");
    (item.categories || []).forEach((category) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.textContent = category;
      chip.addEventListener("click", () => {
        categoryEl.value = category;
        runFilter();
      });
      chipsEl.appendChild(chip);
    });

    fragment.appendChild(node);
  }

  listEl.appendChild(fragment);

  if (items.length > visibleCount) {
    listEl.appendChild(createShowMoreButton(items.length));
  }
}

function computeCategoriesForDay(day) {
  const source = day
    ? allArticles.filter((item) => item.published_day === day)
    : allArticles;

  return Array.from(
    new Set(source.flatMap((item) => (Array.isArray(item.categories) ? item.categories : [])))
  ).sort((a, b) => a.localeCompare(b, "cs"));
}

function updateCategoryOptions() {
  const selectedDay = dayEl.value;
  const previousCategory = categoryEl.value;
  const categories = computeCategoriesForDay(selectedDay);

  fillSelect(categoryEl, categories, "Všechny kategorie");

  if (previousCategory && categories.includes(previousCategory)) {
    categoryEl.value = previousCategory;
  }
}

function applyPayload(payload, isArchive) {
  const previousDay = dayEl.value;
  const previousCategory = categoryEl.value;
  const categories = Array.isArray(payload.categories) ? payload.categories : [];
  const days = Array.isArray(payload.published_days) ? payload.published_days : [];

  allArticles = Array.isArray(payload.articles) ? payload.articles : [];
  archiveLoaded = isArchive;
  latestDay = payload.latest_day || days[0] || latestDay;
  totalArticleCount = Number(payload.total_count || payload.count || allArticles.length);

  fillSelect(dayEl, days, "Všechny dny");
  fillSelect(categoryEl, categories, "Všechny kategorie");

  if (previousDay && days.includes(previousDay)) {
    dayEl.value = previousDay;
  } else if (!previousDay && isArchive) {
    dayEl.value = "";
  } else if (latestDay) {
    dayEl.value = latestDay;
  }

  if (previousCategory && categories.includes(previousCategory)) {
    categoryEl.value = previousCategory;
  }

  metaEl.dataset.generatedAtText = `Naposledy vygenerováno: ${formatDate(payload.generated_at)}`;
}

async function fetchPayload(url) {
  const response = await fetch(url, { cache: "no-store" });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}

async function loadArchiveIfNeeded() {
  const selectedDay = dayEl.value;
  const needsArchive = !archiveLoaded && (!selectedDay || selectedDay !== latestDay);

  if (!needsArchive) {
    return;
  }

  metaEl.textContent = "Načítám celý archiv…";
  applyPayload(await fetchPayload(FULL_DATA_URL), true);
}

async function applyFilter(resetVisible = true) {
  if (resetVisible) {
    visibleCount = PAGE_SIZE;
  }

  await loadArchiveIfNeeded();
  updateCategoryOptions();

  const q = searchEl.value.trim().toLowerCase();
  const selectedDay = dayEl.value;
  const selectedCategory = categoryEl.value;

  filteredArticles = allArticles.filter((item) => {
    if (q && !(item.title || "").toLowerCase().includes(q)) {
      return false;
    }

    if (selectedDay && item.published_day !== selectedDay) {
      return false;
    }

    if (selectedCategory && !(item.categories || []).includes(selectedCategory)) {
      return false;
    }

    return true;
  });

  updateMeta();
  render(filteredArticles);
}

async function load() {
  try {
    let payload;
    let isArchive = false;

    try {
      payload = await fetchPayload(LATEST_DATA_URL);
    } catch {
      payload = await fetchPayload(FULL_DATA_URL);
      isArchive = true;
    }

    applyPayload(payload, isArchive);

    if (latestDay) {
      dayEl.value = latestDay;
    }

    await applyFilter();
    syncAllPlaybackRates();
  } catch (error) {
    showError("Nepodařilo se načíst index článků.", error.message);
  }
}

const debouncedApplyFilter = debounce(runFilter, SEARCH_DEBOUNCE_MS);

searchEl.addEventListener("input", debouncedApplyFilter);
dayEl.addEventListener("change", runFilter);
categoryEl.addEventListener("change", runFilter);
load();

if (speedEl) {
  if (!["0.75", "1", "1.25", "1.5", "1.75", "2"].includes(String(playbackRate))) {
    playbackRate = 1;
  }
  speedEl.value = String(playbackRate);
  speedEl.addEventListener("change", () => {
    playbackRate = Number(speedEl.value || "1");
    localStorage.setItem("preferredPlaybackRate", String(playbackRate));
    syncAllPlaybackRates();
  });
}
