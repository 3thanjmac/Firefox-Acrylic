"use strict";

const canvas = document.getElementById("acrylic");
let state = null;
let bitmap = null;
let bitmapSource = null;

// Storage is async; paint the last known tint synchronously to avoid a white flash.
const FIRST_PAINT_KEY = "acrylic:first-paint";
document.documentElement.style.backgroundColor = localStorage.getItem(FIRST_PAINT_KEY) || "";

async function refresh() {
  state = await Acrylic.load();
  if (state.image !== bitmapSource) {
    bitmapSource = state.image;
    bitmap = await Acrylic.decodeImage(state.image);
  }
  draw();
}

function draw() {
  if (!state) return;
  const s = state.settings;
  Acrylic.render(canvas, {
    width: innerWidth,
    height: innerHeight,
    scale: Math.min(devicePixelRatio || 1, 2),
    plain: !s.homepage,
    source: s.source,
    bitmap,
    tint: s.color,
    baseColor: s.color,
    tintOpacity: s.tintOpacity,
    luminosity: s.luminosity,
    blur: s.blur,
    saturation: s.saturation,
    noise: s.noise,
  });
  const firstPaint = s.homepage && s.source === "native" ? "transparent" : s.color;
  document.documentElement.style.backgroundColor = firstPaint;
  localStorage.setItem(FIRST_PAINT_KEY, firstPaint);
}

let resizeTimer = 0;
addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(draw, 120);
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.settings || changes.image)) refresh();
});

refresh();
