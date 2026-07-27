/**
 * Which tray image each platform uses, and therefore which files have to be
 * packaged.
 *
 * One list, two consumers that would otherwise drift silently: `src/main/tray.ts`
 * picks the image to load, and `electron.vite.config.ts` copies the files into
 * `dist/main/` so the packaged app has them. Adding a platform to one and not
 * the other packages green and produces an app with no tray — a runtime-only
 * failure on whichever platform was missed.
 *
 * @module shared/tray-images
 */

/** The Retina companion Electron looks for beside a tray image. */
function retinaVariant(fileName: string): string {
  return fileName.replace(/\.png$/, '@2x.png');
}

/**
 * The tray image for each platform we ship one for, keyed by `process.platform`.
 *
 * macOS gets a **template** image: a black-on-transparent glyph the OS recolours
 * for light and dark menu bars. The `Template` suffix in the filename is what
 * marks it as one — do not rename it.
 *
 * Windows gets the full app mark instead, white on its own dark chip. A
 * template-style monochrome glyph would disappear into one of the two Windows
 * taskbar themes; the chip carries its own contrast, so it reads on both. It is
 * a PNG rather than the `.ico` the installer uses because Electron only decodes
 * `.ico` on Windows — a `.ico` tray asset cannot be verified anywhere else, and
 * the Windows build is not one we can confirm by hand yet.
 *
 * Linux has no entry: there is no Linux build, and a tray there needs a
 * `libappindicator` host we cannot assume. Closing the last window quits
 * instead — see `src/main/index.ts`.
 */
export const TRAY_IMAGE_BY_PLATFORM: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'trayTemplate.png',
  win32: 'trayIcon.png',
};

/**
 * Every tray image file the build must package: each platform's image plus its
 * `@2x` sibling.
 *
 * The `@2x` files are never named at load time — Electron's `nativeImage` finds
 * a `@2x` sibling on its own — so they only have to land in the same directory.
 */
export const TRAY_IMAGE_FILES: readonly string[] = Object.values(TRAY_IMAGE_BY_PLATFORM).flatMap(
  (fileName) => [fileName, retinaVariant(fileName)]
);
