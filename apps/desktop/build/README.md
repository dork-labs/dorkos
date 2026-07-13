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
