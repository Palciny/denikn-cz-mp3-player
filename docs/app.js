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

let allArticles = [];
let playbackRate = Number(localStorage.getItem("preferredPlaybackRate") || "1");

function createOption(value, label) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  return option;
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

function render(items) {
  listEl.innerHTML = "";

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Pro tento filtr nebyly nalezeny žádné články.";
    listEl.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();

  for (const item of items) {
    const node = template.content.cloneNode(true);
    node.querySelector(".title").textContent = item.title || item.url;

    const categoryText = Array.isArray(item.categories) && item.categories.length
      ? item.categories.join(", ")
      : "Bez kategorie";
    node.querySelector(".details").textContent = `Publikováno: ${formatDate(item.published)} · Kategorie: ${categoryText}`;

    const articleLink = node.querySelector(".article-link");
    articleLink.href = item.url;

    const mp3Link = node.querySelector(".mp3-link");
    mp3Link.href = item.mp3_url;

    const audio = node.querySelector("audio");
    audio.src = item.mp3_url;
    const speedValueEl = node.querySelector(".speed-value");
    applyPlaybackRate(audio, speedValueEl);
    audio.addEventListener("loadedmetadata", () => applyPlaybackRate(audio, speedValueEl));
    audio.addEventListener("play", () => applyPlaybackRate(audio, speedValueEl));

    const chipsEl = node.querySelector(".chips");
    (item.categories || []).forEach((category) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.textContent = category;
      chip.addEventListener("click", () => {
        categoryEl.value = category;
        applyFilter();
      });
      chipsEl.appendChild(chip);
    });

    fragment.appendChild(node);
  }

  listEl.appendChild(fragment);
}

function applyFilter() {
  const q = searchEl.value.trim().toLowerCase();
  const selectedDay = dayEl.value;
  const selectedCategory = categoryEl.value;

  const filtered = allArticles.filter((item) => {
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

  metaEl.dataset.filteredCount = String(filtered.length);
  const generatedAt = metaEl.dataset.generatedAtText || "";
  const total = allArticles.length;
  metaEl.textContent = `${generatedAt} · Zobrazeno: ${filtered.length} z ${total}`;
  render(filtered);
}

async function load() {
  try {
    const response = await fetch("data/articles.json", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    allArticles = Array.isArray(payload.articles) ? payload.articles : [];
    const categories = Array.isArray(payload.categories) ? payload.categories : [];
    const days = Array.isArray(payload.published_days) ? payload.published_days : [];

    fillSelect(dayEl, days, "Všechny dny");
    fillSelect(categoryEl, categories, "Všechny kategorie");

    metaEl.dataset.generatedAtText = `Naposledy vygenerováno: ${formatDate(payload.generated_at)}`;
    metaEl.textContent = `${metaEl.dataset.generatedAtText} · Zobrazeno: ${allArticles.length} z ${allArticles.length}`;
    render(allArticles);
    syncAllPlaybackRates();
  } catch (error) {
    metaEl.textContent = "Nepodařilo se načíst index článků.";
    listEl.innerHTML = `<div class="empty">${error.message}</div>`;
  }
}

searchEl.addEventListener("input", applyFilter);
dayEl.addEventListener("change", applyFilter);
categoryEl.addEventListener("change", applyFilter);
load();


if (speedEl) {
  if (!["0.75","1","1.25","1.5","1.75","2"].includes(String(playbackRate))) {
    playbackRate = 1;
  }
  speedEl.value = String(playbackRate);
  speedEl.addEventListener("change", () => {
    playbackRate = Number(speedEl.value || "1");
    localStorage.setItem("preferredPlaybackRate", String(playbackRate));
    syncAllPlaybackRates();
  });
}
