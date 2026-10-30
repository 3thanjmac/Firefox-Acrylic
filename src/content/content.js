"use strict";

// Replaces a website's root background with the acrylic material.
// The material is a fixed, closed-shadow-DOM canvas behind all page content.
// Everything is drawn on a canvas so strict page CSPs (img-src / style-src) can't block it.
(() => {
  const root = document.documentElement;
  if (window.top !== window) return;
  if (root?.localName !== "html" || root.namespaceURI !== "http://www.w3.org/1999/xhtml") return;
  if (document.contentType !== "text/html" && document.contentType !== "application/xhtml+xml") return;

  const host = Acrylic.hostKey(location.href);
  if (!host) return;

  const ATTR = "data-acrylic";
  const CLEAR_ATTR = "data-acrylic-clear";
  const RENDER_SCALE = 0.5; // the material is heavily blurred; half resolution is indistinguishable and 4× cheaper
  const DEEP_SCAN_LIMIT = 6000;
  const DARK_CANVAS = { r: 28, g: 27, b: 34, a: 1 };
  const LIGHT_CANVAS = { r: 255, g: 255, b: 255, a: 1 };

  let state = null; // { settings, sites, image }
  let config = null; // effective site config
  let bitmap = null;
  let bitmapSource = null;
  let page = null; // { bg } — the page's own background, read with our override disabled
  let layer = null; // { el, canvas }
  let active = false;
  let ready = document.readyState !== "loading";

  let rootObserver = null;
  let deepObserver = null;
  let deepTimer = 0;
  let lastDeepScan = 0;
  let recheckTimer = 0;
  let resizeTimer = 0;

  // ----------------------------------------------------------- detection

  function readPageColors() {
    const previous = root.getAttribute(ATTR);
    if (previous !== null) root.removeAttribute(ATTR);
    const htmlCs = getComputedStyle(root);
    const bodyCs = document.body ? getComputedStyle(document.body) : null;
    // Read before restoring the attribute: computed values are live.
    const htmlBg = Acrylic.parseCssColor(htmlCs.backgroundColor);
    const bodyBg = bodyCs ? Acrylic.parseCssColor(bodyCs.backgroundColor) : null;
    const text = Acrylic.parseCssColor((bodyCs || htmlCs).color);
    if (previous !== null) root.setAttribute(ATTR, previous);

    // Same order as CSS root-background propagation: <html>, then <body>.
    let bg = htmlBg.a >= 0.5 ? htmlBg : bodyBg && bodyBg.a >= 0.5 ? bodyBg : null;
    // No background at all: the browser's canvas color, which follows the text color's scheme.
    if (!bg) bg = Acrylic.luminance(text) > 0.4 ? DARK_CANVAS : LIGHT_CANVAS;
    return { bg };
  }

  const colorDistance = (a, b) => Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));

  function recheck() {
    if (!active) return;
    const next = readPageColors();
    if (page && colorDistance(next.bg, page.bg) < 2) return;
    page = next;
    render();
    if (config.coverage === "deep") {
      clearDeepMarks();
      scanDeep();
    }
  }

  function scheduleRecheck(delay = 100) {
    clearTimeout(recheckTimer);
    recheckTimer = setTimeout(recheck, delay);
  }

  // -------------------------------------------------------------- layer

  function setStyles(el, styles) {
    for (const [prop, value] of Object.entries(styles)) el.style.setProperty(prop, value, "important");
  }

  function mountLayer() {
    if (!layer) {
      const el = document.createElement("acrylic-backdrop");
      const shadow = el.attachShadow({ mode: "closed" });
      const canvas = document.createElement("canvas");
      setStyles(canvas, { display: "block", width: "100%", height: "100%" });
      shadow.appendChild(canvas);
      setStyles(el, {
        all: "initial",
        display: "block",
        position: "fixed",
        inset: "0",
        "z-index": "-2147483647",
        "pointer-events": "none",
        contain: "strict",
      });
      el.setAttribute("aria-hidden", "true");
      layer = { el, canvas };
    }
    if (layer.el.parentNode !== root) root.appendChild(layer.el);
  }

  function render() {
    if (!active || !layer || !page) return;
    const s = state.settings;
    const source = s.source === "image" && !bitmap ? "ambient" : s.source;
    Acrylic.render(layer.canvas, {
      width: innerWidth,
      height: innerHeight,
      scale: RENDER_SCALE,
      source,
      bitmap,
      tint: Acrylic.toneColor(config.color, config.tone, page.bg),
      baseColor: config.color,
      tintOpacity: config.tintOpacity,
      luminosity: s.luminosity,
      blur: config.blur,
      saturation: s.saturation,
      noise: s.noise,
    });
  }

  // --------------------------------------------------------- deep coverage

  // "Deep" also clears large containers painted with the page's own background color,
  // e.g. a full-height white <div id="app"> that would otherwise hide the material.
  function scanDeep() {
    if (!active || config.coverage !== "deep" || !page || !document.body) return;
    lastDeepScan = performance.now();
    const vw = innerWidth;
    const vh = innerHeight;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let count = 0;
    for (let el = walker.nextNode(); el && count < DEEP_SCAN_LIMIT; el = walker.nextNode(), count++) {
      if (el.hasAttribute(CLEAR_ATTR)) continue;
      const cs = getComputedStyle(el);
      const bg = cs.backgroundColor;
      if (bg === "rgba(0, 0, 0, 0)" || bg === "transparent" || cs.backgroundImage !== "none") continue;
      const color = Acrylic.parseCssColor(bg);
      if (color.a < 0.85 || colorDistance(color, page.bg) > 18) continue;
      const rect = el.getBoundingClientRect();
      const large =
        (rect.width >= vw * 0.45 && rect.height >= vh * 0.25) || // main content areas
        (rect.width >= vw * 0.12 && rect.height >= vh * 0.6) || // full-height side panels
        rect.width >= vw * 0.9; // full-width bars
      if (large) el.setAttribute(CLEAR_ATTR, "");
    }
  }

  function scheduleDeepScan() {
    if (deepTimer) return;
    const wait = Math.max(250, 1000 - (performance.now() - lastDeepScan));
    deepTimer = setTimeout(() => {
      deepTimer = 0;
      scanDeep();
    }, wait);
  }

  function clearDeepMarks() {
    for (const el of document.querySelectorAll(`[${CLEAR_ATTR}]`)) el.removeAttribute(CLEAR_ATTR);
  }

  function startDeep() {
    if (!deepObserver) {
      deepObserver = new MutationObserver(scheduleDeepScan);
      deepObserver.observe(document.body, { childList: true, subtree: true });
    }
    scanDeep();
  }

  function stopDeep() {
    deepObserver?.disconnect();
    deepObserver = null;
    clearTimeout(deepTimer);
    deepTimer = 0;
    clearDeepMarks();
  }

  // ----------------------------------------------------------- lifecycle

  function observeRoot() {
    if (rootObserver) return;
    rootObserver = new MutationObserver((records) => {
      if (!active) return;
      if (layer && layer.el.parentNode !== root) root.appendChild(layer.el);
      // Theme switches usually flip a class/attribute on <html> or <body>.
      if (records.some((r) => r.type === "attributes" && !r.attributeName.startsWith(ATTR))) scheduleRecheck();
    });
    rootObserver.observe(root, { attributes: true, childList: true });
    if (document.body) rootObserver.observe(document.body, { attributes: true });
  }

  function teardown() {
    if (!active) return;
    active = false;
    root.removeAttribute(ATTR);
    layer?.el.remove();
    stopDeep();
    rootObserver?.disconnect();
    rootObserver = null;
  }

  async function syncImage() {
    const wanted = state.settings.source === "image" ? state.image : null;
    if (wanted === bitmapSource) return;
    bitmapSource = wanted;
    bitmap = await Acrylic.decodeImage(wanted);
  }

  async function update() {
    state = await Acrylic.load();
    config = Acrylic.siteConfig(state.settings, state.sites, host);
    if (!config.enabled) {
      teardown();
      return;
    }
    await syncImage();
    if (!ready || !document.body) return; // applied on DOMContentLoaded

    if (!page) page = readPageColors();
    root.setAttribute(ATTR, config.coverage === "deep" ? "deep" : "background");
    active = true;
    mountLayer();
    observeRoot();
    render();
    if (config.coverage === "deep") startDeep();
    else stopDeep();
  }

  // -------------------------------------------------------------- events

  // Applying after the DOM is parsed (rather than at document_start) avoids forcing style
  // resolution before the page's stylesheets arrive, which would misread its background.
  if (!ready) {
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        ready = true;
        update();
      },
      { once: true },
    );
  }
  // Late stylesheets / web fonts can still change the page background after DOMContentLoaded.
  addEventListener("load", () => scheduleRecheck(0), { once: true });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => scheduleRecheck(50));

  addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(render, 150);
  });

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes.settings || changes.sites || changes.image)) update();
  });

  browser.runtime.onMessage.addListener((message) => {
    if (message?.type !== "acrylic:status") return undefined;
    return Promise.resolve({
      host,
      active,
      pageBackground: page ? Acrylic.rgbToHex(page.bg) : null,
    });
  });

  update();
})();
