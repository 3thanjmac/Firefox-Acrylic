"use strict";

const $ = (id) => document.getElementById(id);
const ALL_SITES = { origins: ["<all_urls>"] };
const IMAGE_MAX_SIDE = 1920;
const LIGHT_PAGE = { r: 255, g: 255, b: 255 };
const DARK_PAGE = { r: 28, g: 27, b: 34 };

const PRESETS = [
  ["Graphite", "#20232b"],
  ["Midnight", "#141a2e"],
  ["Slate", "#2b3340"],
  ["Ocean", "#0f2a3a"],
  ["Forest", "#1d2b24"],
  ["Plum", "#2e1f33"],
  ["Mist", "#e9ecf2"],
  ["Sand", "#efe6d8"],
];

const SOURCE_HELP = {
  ambient: "A soft color field generated from the base color.",
  image: "Your wallpaper image, blurred.",
  native: "The real Windows acrylic behind the window. Needs the setup at the bottom of this page.",
};

let state = null;
let bitmap = null;
let bitmapSource = null;

// -------------------------------------------------------------- rendering

function materialOptions(canvas, tint) {
  const s = state.settings;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  return {
    width: canvas.clientWidth,
    height: canvas.clientHeight,
    scale: dpr,
    source: s.source === "image" && !bitmap ? "ambient" : s.source,
    bitmap,
    tint,
    baseColor: s.color,
    tintOpacity: s.tintOpacity,
    luminosity: s.luminosity,
    blur: s.blur,
    saturation: s.saturation,
    noise: s.noise,
  };
}

function drawMaterials() {
  const s = state.settings;
  const tone = s.matchPage ? "auto" : "base";
  const backdrop = $("backdrop");
  Acrylic.render(backdrop, { ...materialOptions(backdrop, s.color), scale: 1 });
  Acrylic.render($("preview-newtab"), materialOptions($("preview-newtab"), s.color));
  Acrylic.render($("preview-light"), materialOptions($("preview-light"), Acrylic.toneColor(s.color, tone, LIGHT_PAGE)));
  Acrylic.render($("preview-dark"), materialOptions($("preview-dark"), Acrylic.toneColor(s.color, tone, DARK_PAGE)));
}

let drawFrame = 0;
function drawSoon() {
  if (drawFrame) return;
  drawFrame = requestAnimationFrame(() => {
    drawFrame = 0;
    drawMaterials();
  });
}

async function syncImage() {
  if (state.image === bitmapSource) return;
  bitmapSource = state.image;
  bitmap = await Acrylic.decodeImage(state.image);
}

// --------------------------------------------------------------- controls

function formatValue(input) {
  const v = Number(input.value);
  return input.dataset.format === "px" ? `${Math.round(v)}px` : `${Math.round(v * 100)}%`;
}

function renderControls() {
  const s = state.settings;
  for (const el of document.querySelectorAll("[data-setting]")) {
    const key = el.dataset.setting;
    if (el.classList.contains("segmented")) {
      for (const b of el.querySelectorAll("button")) b.setAttribute("aria-checked", String(b.value === s[key]));
    } else if (el.type === "checkbox") {
      el.checked = s[key];
    } else if (document.activeElement !== el) {
      el.value = s[key];
    }
    if (el.type === "range") el.nextElementSibling.value = formatValue(el);
  }
  for (const b of $("presets").children) b.setAttribute("aria-checked", String(b.value === s.color));

  $("source-help").textContent = SOURCE_HELP[s.source] || "";
  $("image-row").hidden = s.source !== "image";
  $("image-thumb").hidden = $("image-remove").hidden = !state.image;
  if (state.image) $("image-thumb").src = state.image;

  const toneLabel = s.matchPage ? "Auto tone" : "Base tone";
  $("preview-light").parentElement.querySelector("figcaption").textContent = `Light website · ${toneLabel}`;
  $("preview-dark").parentElement.querySelector("figcaption").textContent = `Dark website · ${toneLabel}`;
}

function describeSite(entry) {
  const parts = [];
  if (entry.enabled !== undefined) parts.push(entry.enabled ? "On" : "Off");
  if (entry.coverage) parts.push(entry.coverage === "deep" ? "Deep" : "Background");
  if (entry.tone) parts.push(`${entry.tone[0].toUpperCase()}${entry.tone.slice(1)} tone`);
  if (entry.tintOpacity !== undefined) parts.push(`Tint ${Math.round(entry.tintOpacity * 100)}%`);
  if (entry.blur !== undefined) parts.push(`Blur ${entry.blur}px`);
  if (entry.color) parts.push(`Color ${entry.color}`);
  return parts.join(" · ");
}

function renderSites() {
  const tbody = document.querySelector("#sites-table tbody");
  tbody.replaceChildren();
  const hosts = Object.keys(state.sites).sort();
  for (const host of hosts) {
    const row = document.createElement("tr");
    const name = document.createElement("td");
    name.textContent = host === "file" ? "Local files" : host;
    const summary = document.createElement("td");
    summary.className = "muted";
    summary.textContent = describeSite(state.sites[host]);
    const actions = document.createElement("td");
    const remove = document.createElement("button");
    remove.textContent = "Remove";
    remove.className = "danger";
    remove.addEventListener("click", () => Acrylic.resetSite(host));
    actions.append(remove);
    row.append(name, summary, actions);
    tbody.append(row);
  }
  $("sites-empty").hidden = hosts.length > 0;
  $("sites-clear").hidden = hosts.length === 0;
}

let pending = {};
let flushTimer = 0;
function saveSoon(patch) {
  Object.assign(pending, patch);
  // Update locally right away so previews follow the slider without waiting for storage.
  Object.assign(state.settings, patch);
  renderControls();
  drawSoon();
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    const batch = pending;
    pending = {};
    flushTimer = 0;
    Acrylic.saveSettings(batch);
  }, 80);
}

function wireControls() {
  for (const el of document.querySelectorAll("[data-setting]")) {
    const key = el.dataset.setting;
    if (el.classList.contains("segmented")) {
      el.addEventListener("click", (e) => {
        const b = e.target.closest("button");
        if (b) saveSoon({ [key]: b.value });
      });
    } else if (el.type === "checkbox") {
      el.addEventListener("change", () => saveSoon({ [key]: el.checked }));
    } else if (el.type === "range") {
      el.addEventListener("input", () => saveSoon({ [key]: Number(el.value) }));
    } else {
      el.addEventListener("input", () => saveSoon({ [key]: el.value }));
    }
  }

  for (const [name, color] of PRESETS) {
    const b = document.createElement("button");
    b.value = color;
    b.title = name;
    b.style.background = color;
    b.addEventListener("click", () => saveSoon({ color }));
    $("presets").append(b);
  }

  $("image-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (file) await importImage(file);
  });
  $("image-remove").addEventListener("click", () => browser.storage.local.remove("image"));

  $("sites-clear").addEventListener("click", () => {
    if (confirm("Remove all per-site adjustments?")) browser.storage.local.set({ sites: {} });
  });

  $("reset-all").addEventListener("click", async () => {
    if (!confirm("Reset every setting, per-site adjustment, and the wallpaper image?")) return;
    await browser.storage.local.clear();
  });

  $("copy-userchrome").addEventListener("click", async () => {
    await navigator.clipboard.writeText($("userchrome").textContent);
    $("copy-userchrome").textContent = "Copied";
    setTimeout(() => ($("copy-userchrome").textContent = "Copy"), 1500);
  });
}

/** Downscales the chosen image and stores it as a JPEG data URL; blur hides the lost detail. */
async function importImage(file) {
  let source;
  try {
    source = await createImageBitmap(file);
  } catch {
    alert("That file couldn't be read as an image.");
    return;
  }
  const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(source.width, source.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(source.width * scale);
  canvas.height = Math.round(source.height * scale);
  canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
  source.close();
  const image = canvas.toDataURL("image/jpeg", 0.88);
  const { settings } = await browser.storage.local.get("settings");
  await browser.storage.local.set({ image, settings: { ...Acrylic.DEFAULTS, ...(settings || {}), source: "image" } });
}

async function setupPermission() {
  const granted = await browser.permissions.contains(ALL_SITES);
  $("permission-card").hidden = granted;
  if (granted) return;
  $("grant").addEventListener("click", async () => {
    if (await browser.permissions.request(ALL_SITES)) $("permission-card").hidden = true;
  });
}

async function refresh() {
  state = await Acrylic.load();
  Object.assign(state.settings, pending); // keep in-flight slider values
  await syncImage();
  renderControls();
  renderSites();
  drawMaterials();
}

async function main() {
  wireControls();
  setupPermission();

  const commands = await browser.commands.getAll();
  const shortcut = commands.find((c) => c.name === "toggle-site")?.shortcut;
  if (shortcut) $("shortcut-hint").textContent = ` or toggled with ${shortcut}`;

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local") refresh();
  });
  addEventListener("resize", drawSoon);
  await refresh();
}

main();
