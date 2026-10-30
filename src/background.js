"use strict";

const NEWTAB_URL = browser.runtime.getURL("src/newtab/newtab.html");

// Keyboard shortcut: flip acrylic for the current site (or the new tab page).
browser.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-site") return;
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return;
  const { settings, sites } = await Acrylic.load();

  if (tab.url.startsWith(NEWTAB_URL)) {
    await Acrylic.saveSettings({ homepage: !settings.homepage });
    return;
  }
  const host = Acrylic.hostKey(tab.url);
  if (!host) return;
  const enabled = !Acrylic.siteConfig(settings, sites, host).enabled;
  // Matching the global default clears the override instead of pinning it.
  await Acrylic.saveSite(host, { enabled: enabled === settings.webpages ? null : enabled });
});
