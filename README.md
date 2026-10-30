# Acrylic Browser

Firefox extension that puts a blurred acrylic material on the new tab / home page and behind the background of
any website, with per-site tuning from the toolbar button.

## Install (Firefox Developer Edition)

Permanent install (unsigned):

1. `about:config` → set `xpinstall.signatures.required` to `false` (Developer Edition honors this).
2. `npm install`, then `npm run build` → `web-ext-artifacts/acrylic_browser-1.0.0.zip`.
3. `about:addons` → gear menu → **Install Add-on From File…** → pick the zip.
4. Accept the prompts (access to all websites, new tab/home page change).

For development: `npm start` (runs `web-ext run` against Developer Edition), or `about:debugging` →
**This Firefox** → **Load Temporary Add-on…** → `manifest.json`.

If "Access your data for all websites" is not granted, the toolbar popup and the settings page show an
**Allow on all websites** button.

## Use

- **New tab / home page**: just the acrylic material.
- **Websites**: the page's root background is replaced by the material. Light sites get a light tint and dark
  sites a dark one (**Match page brightness**), so text stays readable.
- **Toolbar button** (quick action), per site:
  - On/off for this site
  - Coverage: **Background** (root background only) or **Deep** (also clears large containers painted the
    page's background color, for sites whose content sits in a full-height `<div>`)
  - Tone: Auto / Light / Dark / Base
  - Tint opacity, blur, custom color
  - Reset site
- **Alt+Shift+A** toggles the current site (or the new tab page). Change it in `about:addons` → gear →
  **Manage Extension Shortcuts**.
- **Settings** (gear in the popup, or `about:addons` → Acrylic → Preferences): acrylic on new tab/home, acrylic on
  websites, backdrop source, base color, tint opacity, luminosity, blur, saturation, noise, default coverage, and
  the list of per-site adjustments.

### Backdrop sources

| Source | What's behind the tint | Setup |
| --- | --- | --- |
| Ambient (default) | Soft color field generated from the base color | None |
| Wallpaper | An image you pick (e.g. your desktop wallpaper), blurred | Choose the image in settings |
| Windows backdrop | The real Windows 11 acrylic behind the window | See below |

An extension can't see what's behind the browser window, so **Ambient** and **Wallpaper** simulate acrylic.
**Windows backdrop** uses the real system material but needs Firefox prefs an extension can't set:

1. `about:config`:
   - `widget.windows.mica` = `true`
   - `widget.windows.mica.toplevel-backdrop` = `2` (acrylic)
   - `browser.tabs.allow_transparent_browser` = `true`
   - `toolkit.legacyUserProfileCustomizations.stylesheets` = `true`
2. Copy [`userChrome.css`](userChrome.css) into `<profile folder>/chrome/userChrome.css`
   (`about:support` → **Profile Folder** → **Open Folder**).
3. Keep the default Firefox theme (Firefox disables Mica/acrylic with other themes) and restart.

## Limits

- Firefox blocks extensions on `about:` pages, `addons.mozilla.org`, and the PDF viewer; those keep their look.
- Pages whose content sits on its own opaque panels only show the material around them; try **Deep** coverage,
  or turn the site off.
- Turning acrylic off for the new tab shows a plain base-color page; an extension can't hand the new tab back to
  Firefox's default page without being disabled.
- Pages already open when the extension is installed need a reload.

## Layout

```
manifest.json
src/shared/acrylic.js   settings, color helpers, canvas renderer (shared by every context)
src/shared/ui.css       controls for popup + settings
src/content/            website background replacement
src/newtab/             new tab / home page
src/popup/              per-site quick action
src/options/            settings page
src/background.js       keyboard shortcut
```
