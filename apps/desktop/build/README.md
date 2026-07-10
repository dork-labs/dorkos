# Desktop build resources

`electron-builder` reads this directory (`directories.buildResources` in
`../electron-builder.yml`):

- `icon.svg` — the app icon source of truth: the standalone "D" glyph from the
  DORK wordmark on a dark rounded square, drawn at 1024×1024. Not consumed by
  the build directly; it exists so the icon can be regenerated.
- `icon.icns` — the compiled macOS icon `electron-builder` actually packages
  (`mac.icon` in `electron-builder.yml`). Regenerate it from `icon.svg`
  whenever the glyph changes — never edit the `.icns` by hand.
- `entitlements.mac.plist` — hardened-runtime entitlements for signing.

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
