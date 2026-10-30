"use strict";

// Shared by the background script, content script, and extension pages.
// Exposes a single global: `Acrylic`.
(() => {
  if (globalThis.Acrylic) return;

  const DEFAULTS = Object.freeze({
    homepage: true, // acrylic on the new tab / home page
    webpages: true, // acrylic behind regular websites (per-site overrides win)
    source: "ambient", // "ambient" | "image" | "native"
    color: "#20232b", // base tint color
    tintOpacity: 0.6,
    luminosity: 0.7,
    blur: 60,
    saturation: 1.3,
    noise: 0.04,
    coverage: "background", // default for websites: "background" | "deep"
    matchPage: true, // websites: adapt tint brightness to the page's own background
  });

  // Fields a site override may set. Anything missing falls back to global settings.
  const SITE_FIELDS = ["enabled", "coverage", "tone", "tintOpacity", "blur", "color"];
  const TONES = ["auto", "light", "dark", "base"];

  // ---------------------------------------------------------------- storage

  async function load() {
    const { settings, sites, image } = await browser.storage.local.get(["settings", "sites", "image"]);
    return {
      settings: { ...DEFAULTS, ...(settings || {}) },
      sites: sites || {},
      image: image || null,
    };
  }

  async function saveSettings(patch) {
    const { settings } = await browser.storage.local.get("settings");
    const next = { ...DEFAULTS, ...(settings || {}), ...patch };
    await browser.storage.local.set({ settings: next });
    return next;
  }

  /** Merge `patch` into the override for `host`. A `null` value removes that field. */
  async function saveSite(host, patch) {
    const { sites = {} } = await browser.storage.local.get("sites");
    const entry = { ...(sites[host] || {}) };
    for (const [key, value] of Object.entries(patch)) {
      if (!SITE_FIELDS.includes(key)) continue;
      if (value === null || value === undefined) delete entry[key];
      else entry[key] = value;
    }
    if (Object.keys(entry).length) sites[host] = entry;
    else delete sites[host];
    await browser.storage.local.set({ sites });
    return entry;
  }

  async function resetSite(host) {
    const { sites = {} } = await browser.storage.local.get("sites");
    delete sites[host];
    await browser.storage.local.set({ sites });
  }

  /** Stable per-site key: hostname without a leading "www.", or "file" for local files. */
  function hostKey(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (parsed.protocol === "file:") return "file";
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.hostname.replace(/^www\./, "");
  }

  /** Effective configuration for a website after applying its override. */
  function siteConfig(settings, sites, host) {
    const o = (host && sites[host]) || {};
    return {
      enabled: o.enabled ?? settings.webpages,
      coverage: o.coverage ?? settings.coverage,
      tone: TONES.includes(o.tone) ? o.tone : settings.matchPage ? "auto" : "base",
      tintOpacity: o.tintOpacity ?? settings.tintOpacity,
      blur: o.blur ?? settings.blur,
      color: o.color ?? settings.color,
      customized: Object.keys(o).length > 0,
    };
  }

  // ----------------------------------------------------------------- colors

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function hexToRgb(hex) {
    let h = String(hex).trim().replace(/^#/, "");
    if (h.length === 3) h = h.replace(/./g, "$&$&");
    const n = parseInt(h.slice(0, 6), 16);
    if (!/^[0-9a-f]{6}/i.test(h) || Number.isNaN(n)) return { r: 32, g: 35, b: 43 };
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function rgbToHex({ r, g, b }) {
    return "#" + [r, g, b].map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, "0")).join("");
  }

  function rgbToHsl({ r, g, b }) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l };
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return { h: h * 60, s, l };
  }

  function hslToRgb({ h, s, l }) {
    h = (((h % 360) + 360) % 360) / 360;
    if (s === 0) return { r: l * 255, g: l * 255, b: l * 255 };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const channel = (t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return { r: channel(h + 1 / 3) * 255, g: channel(h) * 255, b: channel(h - 1 / 3) * 255 };
  }

  /** WCAG relative luminance, 0..1. */
  function luminance({ r, g, b }) {
    const lin = (c) => {
      c /= 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }

  // Parses any CSS color (rgb(), oklch(), color(), named...) by letting a canvas resolve it.
  let probe = null;
  const parsedColors = new Map();
  function parseCssColor(value) {
    if (parsedColors.has(value)) return parsedColors.get(value);
    if (!probe) {
      const c = document.createElement("canvas");
      c.width = c.height = 1;
      probe = c.getContext("2d", { willReadFrequently: true });
    }
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = "rgba(0, 0, 0, 0)";
    probe.fillStyle = value;
    probe.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
    // Un-premultiplied values are imprecise at low alpha; that's fine for our heuristics.
    const color = { r, g, b, a: a / 255 };
    if (parsedColors.size > 512) parsedColors.clear();
    parsedColors.set(value, color);
    return color;
  }

  /**
   * Tint color for a website.
   * "base"  — the base color exactly.
   * "light" / "dark" — the base hue at a fixed light/dark lightness.
   * "auto"  — light or dark depending on the page's own background, so the page's text stays readable.
   */
  function toneColor(baseHex, tone, pageBg) {
    if (tone === "base") return baseHex;
    const { h, s } = rgbToHsl(hexToRgb(baseHex));
    let light;
    if (tone === "light") light = true;
    else if (tone === "dark") light = false;
    else light = pageBg ? luminance(pageBg) > 0.3 : false;

    if (light) {
      const pageL = pageBg && tone === "auto" ? rgbToHsl(pageBg).l : 0.94;
      return rgbToHex(hslToRgb({ h, s: Math.min(s, 0.7), l: clamp(pageL, 0.86, 0.95) }));
    }
    const pageL = pageBg && tone === "auto" ? rgbToHsl(pageBg).l : 0.11;
    return rgbToHex(hslToRgb({ h, s: Math.min(s, 0.6), l: clamp(pageL, 0.07, 0.18) }));
  }

  // --------------------------------------------------------------- renderer

  /** Decodes a data: URL into an ImageBitmap without any network request (page CSP can't block it). */
  async function decodeImage(dataUrl) {
    if (!dataUrl) return null;
    const comma = dataUrl.indexOf(",");
    const mime = /^data:([^;,]+)/.exec(dataUrl)?.[1] || "image/jpeg";
    const bin = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    try {
      return await createImageBitmap(new Blob([bytes], { type: mime }));
    } catch {
      return null;
    }
  }

  let noiseTile = null;
  function getNoiseTile() {
    if (noiseTile) return noiseTile;
    const size = 128;
    noiseTile = document.createElement("canvas");
    noiseTile.width = noiseTile.height = size;
    const ctx = noiseTile.getContext("2d");
    const img = ctx.createImageData(size, size);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = (Math.random() * 255) | 0;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return noiseTile;
  }

  // Soft color field derived from the base color; stands in for a wallpaper.
  const ambientCache = { key: "", canvas: null };
  function getAmbient(baseHex, w, h) {
    const key = `${baseHex}|${w}|${h}`;
    if (ambientCache.key === key) return ambientCache.canvas;

    const base = rgbToHsl(hexToRgb(baseHex));
    const hue = base.s < 0.12 ? 225 : base.h;
    const sat = base.s < 0.12 ? 0.55 : clamp(base.s, 0.45, 0.85);
    const c = ambientCache.canvas || document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    ctx.fillStyle = `hsl(${hue} ${sat * 60}% 18%)`;
    ctx.fillRect(0, 0, w, h);

    const r = Math.max(w, h);
    const blobs = [
      [0.12, 0.18, 0.55, hue + 40, 0.55],
      [0.88, 0.12, 0.5, hue - 35, 0.5],
      [0.72, 0.88, 0.62, hue + 150, 0.45],
      [0.18, 0.92, 0.45, hue - 90, 0.5],
      [0.5, 0.45, 0.35, hue, 0.6],
    ];
    for (const [x, y, rad, bh, l] of blobs) {
      const g = ctx.createRadialGradient(x * w, y * h, 0, x * w, y * h, rad * r);
      g.addColorStop(0, `hsl(${bh} ${sat * 100}% ${l * 100}% / 0.9)`);
      g.addColorStop(1, `hsl(${bh} ${sat * 100}% ${l * 100}% / 0)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
    ambientCache.key = key;
    ambientCache.canvas = c;
    return c;
  }

  function drawCover(ctx, img, x, y, w, h) {
    const iw = img.width;
    const ih = img.height;
    const s = Math.max(w / iw, h / ih);
    const dw = iw * s;
    const dh = ih * s;
    ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  }

  /**
   * Paints the acrylic material into `canvas`.
   * Layers (bottom → top), following Fluent acrylic: blurred + saturated backdrop,
   * luminosity layer, tint layer, noise.
   * In "native" mode the backdrop is the real OS window material, so only tint + noise are drawn.
   */
  function render(canvas, o) {
    const scale = o.scale ?? 1;
    const W = Math.max(1, Math.round(o.width * scale));
    const H = Math.max(1, Math.round(o.height * scale));
    if (canvas.width !== W) canvas.width = W;
    if (canvas.height !== H) canvas.height = H;
    const ctx = canvas.getContext("2d");
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.filter = "none";
    ctx.clearRect(0, 0, W, H);

    if (o.plain) {
      ctx.fillStyle = o.tint;
      ctx.fillRect(0, 0, W, H);
      return;
    }

    if (o.source !== "native") {
      const src = o.source === "image" && o.bitmap ? o.bitmap : getAmbient(o.baseColor || o.tint, W, H);
      const blur = Math.max(0, o.blur) * scale;
      const m = blur * 2; // overscan so the blur doesn't fade at the edges
      ctx.filter = `blur(${blur}px) saturate(${o.saturation})`;
      drawCover(ctx, src, -m, -m, W + 2 * m, H + 2 * m);
      ctx.filter = "none";

      if (o.luminosity > 0) {
        ctx.globalCompositeOperation = "luminosity";
        ctx.globalAlpha = clamp(o.luminosity, 0, 1);
        ctx.fillStyle = o.tint;
        ctx.fillRect(0, 0, W, H);
        ctx.globalCompositeOperation = "source-over";
      }
    }

    ctx.globalAlpha = clamp(o.tintOpacity, 0, 1);
    ctx.fillStyle = o.tint;
    ctx.fillRect(0, 0, W, H);

    if (o.noise > 0) {
      ctx.globalAlpha = clamp(o.noise, 0, 1);
      ctx.fillStyle = ctx.createPattern(getNoiseTile(), "repeat");
      ctx.fillRect(0, 0, W, H);
    }
    ctx.globalAlpha = 1;
  }

  globalThis.Acrylic = {
    DEFAULTS,
    SITE_FIELDS,
    TONES,
    load,
    saveSettings,
    saveSite,
    resetSite,
    hostKey,
    siteConfig,
    hexToRgb,
    rgbToHex,
    rgbToHsl,
    hslToRgb,
    luminance,
    parseCssColor,
    toneColor,
    decodeImage,
    render,
  };
})();
