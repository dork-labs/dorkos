/**
 * Lazy loader for the in-frame rasterizer source (DOR-213 Phase 3).
 *
 * `browser_screenshot` needs the preview to rasterize its OWN document — the
 * parent cannot canvas-read an opaque-origin frame. The rasterizer library
 * (html-to-image, UMD build) is therefore DELIVERED to the frame over
 * `postMessage` as source text: the shim injects it once as a runtime inline
 * `<script>`, the same CSP class as the shim itself, so no cross-origin fetch
 * and no new server route are needed.
 *
 * The source is imported as a raw-text Vite chunk on the FIRST capture request
 * only — it never enters the main client bundle, and a session that never
 * screenshots never downloads it. Cached after the first load.
 *
 * @module features/canvas/lib/load-rasterizer
 */

let cached: string | null = null;

/**
 * Load (once) and return the html-to-image UMD source to deliver to the shim.
 */
export async function loadRasterizerSource(): Promise<string> {
  if (cached === null) {
    const mod = await import('html-to-image/dist/html-to-image.js?raw');
    cached = mod.default;
  }
  return cached;
}
