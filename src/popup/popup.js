"use strict";

const $ = (id) => document.getElementById(id);
const ALL_SITES = { origins: ["<all_urls>"] };
const NEWTAB_URL = browser.runtime.getURL("src/newtab/newtab.html");

let tab = null;
let host = null;
let state = null;

/** Global value a site field falls back to; saving that value clears the override instead. */
function inherited(key) {
  const s = state.settings;
  return {
    enabled: s.webpages,
    coverage: s.coverage,
    tone: s.matchPage ? "auto" : "base",
    tintOpacity: s.tintOpacity,
    blur: s.blur,
    color: s.color,
  }[key];
}

function saveSiteField(key, value) {
  return Acrylic.saveSite(host, { [key]: value === inherited(key) ? null : value });
}

let pending = {};
let flushTimer = 0;
function saveSiteFieldSoon(key, value) {
  pending[key] = value;
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    const batch = pending;
    pending = {};
    flushTimer = 0;
    const patch = {};
    for (const [k, v] of Object.entries(batch)) patch[k] = v === inherited(k) ? null : v;
    await Acrylic.saveSite(host, patch);
  }, 60);
}

function formatValue(id, value) {
  return id === "blur" ? `${Math.round(value)}px` : `${Math.round(value * 100)}%`;
}

function renderSite() {
  const cfg = Acrylic.siteConfig(state.settings, state.sites, host);
  $("enabled").checked = cfg.enabled;
  $("override-note").textContent = cfg.customized ? "Customized for this site" : "Using your defaults";
  $("tuning").disabled = !cfg.enabled;
  $("reset").disabled = !cfg.customized;

  for (const group of document.querySelectorAll(".segmented")) {
    for (const button of group.querySelectorAll("button")) {
      button.setAttribute("aria-checked", String(button.value === cfg[group.dataset.key]));
    }
  }
  for (const id of ["tintOpacity", "blur"]) {
    const input = $(id);
    if (document.activeElement !== input) input.value = cfg[id];
    input.nextElementSibling.value = formatValue(id, Number(input.value));
  }
  const custom = state.sites[host]?.color != null;
  $("custom-color").checked = custom;
  $("color").disabled = !custom;
  $("color").value = cfg.color;
}

async function refreshStatus() {
  const status = $("status");
  const cfg = Acrylic.siteConfig(state.settings, state.sites, host);
  try {
    const reply = await browser.tabs.sendMessage(tab.id, { type: "acrylic:status" });
    if (!cfg.enabled) status.textContent = "Off on this site.";
    else if (reply.active) status.textContent = `Active · page background ${reply.pageBackground}`;
    else status.textContent = "Waiting for the page to finish loading…";
  } catch {
    status.textContent = "Reload the page to apply (some Mozilla pages block extensions).";
  }
}

async function setupSite() {
  $("site-panel").hidden = false;
  $("host").textContent = host === "file" ? "Local files" : host;
  renderSite();
  refreshStatus();

  $("enabled").addEventListener("change", async (e) => {
    await saveSiteField("enabled", e.target.checked);
    setTimeout(refreshStatus, 150);
  });

  for (const group of document.querySelectorAll(".segmented")) {
    group.addEventListener("click", (e) => {
      const button = e.target.closest("button");
      if (button) saveSiteField(group.dataset.key, button.value);
    });
  }

  for (const id of ["tintOpacity", "blur"]) {
    $(id).addEventListener("input", (e) => {
      const value = Number(e.target.value);
      e.target.nextElementSibling.value = formatValue(id, value);
      saveSiteFieldSoon(id, value);
    });
  }

  $("custom-color").addEventListener("change", (e) => {
    saveSiteField("color", e.target.checked ? $("color").value : null);
  });
  $("color").addEventListener("input", (e) => saveSiteFieldSoon("color", e.target.value));

  $("reset").addEventListener("click", () => Acrylic.resetSite(host));
}

function setupNewtab() {
  $("newtab-panel").hidden = false;
  $("host").textContent = "New tab";
  $("homepage").checked = state.settings.homepage;
  $("homepage").addEventListener("change", (e) => Acrylic.saveSettings({ homepage: e.target.checked }));
}

async function setupPermissionNotice() {
  if (await browser.permissions.contains(ALL_SITES)) return;
  $("permission-panel").hidden = false;
  $("grant").addEventListener("click", async () => {
    if (await browser.permissions.request(ALL_SITES)) window.close();
  });
}

async function main() {
  [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  state = await Acrylic.load();

  $("open-options").addEventListener("click", () => {
    browser.runtime.openOptionsPage();
    window.close();
  });

  const commands = await browser.commands.getAll();
  const shortcut = commands.find((c) => c.name === "toggle-site")?.shortcut;
  if (shortcut) $("shortcut").textContent = shortcut;
  else $("shortcut").parentElement.hidden = true;

  setupPermissionNotice();

  if (tab?.url?.startsWith(NEWTAB_URL)) {
    setupNewtab();
  } else if ((host = tab?.url ? Acrylic.hostKey(tab.url) : null)) {
    await setupSite();
  } else {
    $("unsupported-panel").hidden = false;
    $("host").textContent = "This page";
  }

  browser.storage.onChanged.addListener(async (changes, area) => {
    if (area !== "local") return;
    state = await Acrylic.load();
    if (host) {
      renderSite();
      refreshStatus();
    }
  });
}

main();
