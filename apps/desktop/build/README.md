# Desktop build resources

`electron-builder` reads this directory (`directories.buildResources` in
`../electron-builder.yml`):

- `icon.svg` — the app icon source of truth: the standalone "D" glyph from the
  DORK wordmark on a dark rounded square, drawn at 1024×1024. Not consumed by
  the build directly; it exists so the icon can be regenerated.
- `icon.icns` — the compiled macOS icon `electron-builder` actually packages
  (`mac.icon` in `electron-builder.yml`). Regenerate it from `icon.svg`
  whenever the glyph changes — never edit the `.icns` by hand.
- `icon.ico` — the compiled Windows icon `electron-builder` packages
  (`win.icon` in `electron-builder.yml`). Multi-resolution (16–256px).
  Regenerate it from `icon.svg` whenever the glyph changes — never edit the
  `.ico` by hand.
- `trayTemplate.svg` — the menu-bar glyph source: the same "D" with the dark
  chip removed, solid black on transparent, padded via the viewBox.
- `trayTemplate.png` / `trayTemplate@2x.png` — the macOS menu-bar icon
  (16px + 32px Retina). The `Template` suffix is what makes macOS treat it as a
  template image and recolour it for light and dark menu bars — **do not
  rename it**.
- `trayIcon.png` / `trayIcon@2x.png` — the Windows notification-area icon
  (16px + 32px), rendered from `icon.svg` so it keeps its dark chip and stays
  legible on both the light and dark Windows taskbar.
- `entitlements.mac.plist` — hardened-runtime entitlements for signing.

`icon.svg` has a consumer outside this directory too: the web cockpit's PWA
icons (`apps/client/public/icon-192.png`, `icon-512.png`,
`maskable-icon-512.png`, `apple-touch-icon.png`) are rendered from the same
glyph, so the "Add to Home Screen" mark on a phone matches the desktop app
icon. See "Regenerating the cockpit PWA icons" below.

**The tray PNGs are read at runtime, unlike everything else here.** This
directory is electron-builder's `buildResources`, which is _not_ packaged into
the app, so `electron.vite.config.ts` copies the four PNGs into `dist/main/`
alongside the compiled main process (where `electron-builder.yml`'s `dist/**`
allowlist ships them). `src/main/tray.ts` resolves them from there; the `@2x`
files need no entry of their own, because Electron's `nativeImage` picks up a
`@2x` sibling automatically.

## Regenerating icon.icns from icon.svg

macOS only. `sips` and `iconutil` ship with macOS; rendering the SVG needs
librsvg (`brew install librsvg`).

```bash
cd apps/desktop/build

# 1. Render the SVG to a 1024×1024 master PNG.
rsvg-convert -w 1024 -h 1024 icon.svg -o icon-1024.png

# 2. Downscale into an .iconset with every size macOS expects (each size
#    plus its @2x Retina variant; 512@2x is the 1024px master itself).
mkdir icon.iconset
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" icon-1024.png --out "icon.iconset/icon_${size}x${size}.png"
  sips -z "$((size * 2))" "$((size * 2))" icon-1024.png --out "icon.iconset/icon_${size}x${size}@2x.png"
done

# 3. Compile the .icns and clean up the intermediates.
iconutil -c icns icon.iconset -o icon.icns
rm -r icon.iconset icon-1024.png
```

Commit the updated `icon.icns` alongside the `icon.svg` change. There is no
pipeline automation for this on purpose — the icon changes rarely, and the
manual loop keeps the toolchain dependency-free.

## Regenerating icon.ico from icon.svg

Any platform with librsvg + ImageMagick (`brew install librsvg imagemagick`).
Each size is rendered natively from the vector with `rsvg-convert` (not
downscaled from one master), so the small sizes stay crisp; ImageMagick then
assembles them into one multi-resolution `.ico`. electron-builder requires a
256×256 image for the Windows `nsis` target, so keep 256 in the list.

```bash
cd apps/desktop/build

# 1. Render the SVG natively at each icon size Windows uses.
for size in 16 32 48 64 128 256; do
  rsvg-convert -w "$size" -h "$size" icon.svg -o "icon-$size.png"
done

# 2. Assemble the PNGs into one multi-resolution .ico, then clean up.
magick icon-16.png icon-32.png icon-48.png icon-64.png icon-128.png icon-256.png icon.ico
rm icon-16.png icon-32.png icon-48.png icon-64.png icon-128.png icon-256.png

# 3. Verify: "MS Windows icon resource" with all six images.
file icon.ico
magick identify icon.ico
```

Commit the updated `icon.ico` alongside the `icon.svg` change.

## Regenerating the tray icons

Any platform with librsvg (`brew install librsvg`). Each size is rendered
natively from the vector, never downscaled — at 16px that is the difference
between a readable "D" and a smudge.

```bash
cd apps/desktop/build

# macOS menu bar: the template glyph (black on transparent).
rsvg-convert -w 16 -h 16 trayTemplate.svg -o trayTemplate.png
rsvg-convert -w 32 -h 32 trayTemplate.svg -o trayTemplate@2x.png

# Windows notification area: the full mark, chip and all.
rsvg-convert -w 16 -h 16 icon.svg -o trayIcon.png
rsvg-convert -w 32 -h 32 icon.svg -o trayIcon@2x.png
```

Check the 16px renders by eye afterwards: the counter of the "D" has to stay
open. If the glyph in `icon.svg` changes, update `trayTemplate.svg`'s `<path>`
to match — it is the same path data with a different fill and viewBox.

## Regenerating the cockpit PWA icons

Not a bash recipe here — the logic lives in
`apps/client/scripts/generate-pwa-icons.ts` (same `rsvg-convert` dependency
as above), which reads this directory's `icon.svg` directly so the two can
never drift apart by hand. Run it with
`npx tsx apps/client/scripts/generate-pwa-icons.ts` whenever the glyph
changes, and commit the four regenerated PNGs under `apps/client/public/`.
