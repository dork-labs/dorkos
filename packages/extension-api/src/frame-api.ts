import type { AppNavigateRefusal } from './cross-app.js';
import type { ExtensionAPI } from './extension-api.js';

/**
 * The global a compiled client bundle assigns its exports to.
 *
 * Client bundles are classic scripts that run inside an app's sandboxed frame,
 * so the frame reads `activate` from this name instead of importing a module.
 */
export const EXTENSION_BUNDLE_GLOBAL = '__dorkosExtension';

/** The extension API major this DorkOS runs: app screens in a sandboxed frame. */
export const EXTENSION_CLIENT_API_VERSION = 2;

/**
 * Whether an app was built for an older extension API and must be rebuilt
 * before any of its screen code runs. There is no compatibility mode.
 *
 * @param manifest - The app's manifest, or the part of it that names the version.
 */
export function needsClientUpdate(manifest: { clientApiVersion?: number }): boolean {
  return manifest.clientApiVersion !== EXTENSION_CLIENT_API_VERSION;
}

/** Version 2 browser API, available only inside an app's isolated frame. */
export interface FrameExtensionAPI extends Omit<
  ExtensionAPI,
  'executeCommand' | 'openCanvas' | 'navigate'
> {
  /** Activation runs once for registrations and once per mounted view. Keep startup work in registration. */
  readonly context: 'registration' | 'view';
  /**
   * Move the person to a page in DorkOS: a core route, one of this app's own
   * `/x/<id>/…` pages (with any query), or a page of an app this app lists in
   * `capabilities.http.apps`, by its item path alone (`/x/<app>/item/<id>`:
   * no query, hash or encoded characters, at most 8 segments).
   *
   * Never throws for a refused address: it answers `{ ok: false }` with why,
   * so the app can say so.
   */
  navigate(path: string): Promise<AppNavigateResult>;
  /**
   * Request JSON from this app's own server router. Requires capabilities.http.
   *
   * With `app`, calls that app's router instead. This app must list it in
   * `capabilities.http.apps`, and it must list the route and method in its
   * `exports.http`. DorkOS tells the other app which app called.
   */
  request<T = unknown>(
    path: string,
    options?: {
      method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
      body?: unknown;
      app?: string;
    }
  ): Promise<T>;
  /**
   * Fetch a picture or video from this app's own server router, to show with
   * `URL.createObjectURL`. Requires capabilities.http. Allowed types: PNG,
   * JPEG, WebP, GIF, AVIF, MP4 and WebM, up to 32 MB. SVG is refused.
   * A failed reply rejects like {@link FrameExtensionAPI.request}.
   */
  media(path: string): Promise<Blob>;
  /** Read this app's non-secret manifest settings. */
  readonly settings: { get<T = unknown>(): Promise<T> };
  /**
   * Put text, data, a widget, a picture or a web page on the canvas. A page
   * must be `http:` or `https:`, and its tab names this app. Files, PDFs,
   * diffs and MCP apps are refused.
   */
  openCanvas(content: FrameCanvasContent): Promise<void>;
  /**
   * Offer to save a file. DorkOS asks the person in its own dialog ("<App>
   * wants to save a file"), then saves it as a plain download. Allowed types:
   * JSON, plain text, CSV, Markdown, PDF, PNG, JPEG and WebP, up to 10 MB.
   * Names that run or install when opened are refused, with no prompt.
   *
   * @returns `saved` when the person chose Save, `cancelled` otherwise.
   */
  download(
    name: string,
    mimeType: string,
    data: string | ArrayBuffer | Blob
  ): Promise<'saved' | 'cancelled'>;
}

/** Why {@link FrameExtensionAPI.navigate} went nowhere. */
export type AppNavigateResultRefusal = AppNavigateRefusal | 'unknown-route';

/** What {@link FrameExtensionAPI.navigate} answers. */
export type AppNavigateResult =
  | { ok: true }
  | {
      ok: false;
      reason: AppNavigateResultRefusal;
      /** One sentence for the app's maker, saying what to change. */
      message: string;
    };

/** What {@link FrameExtensionAPI.openCanvas} accepts. */
export type FrameCanvasContent =
  | { type: 'markdown'; content: string; title?: string }
  | { type: 'json'; data: unknown; title?: string }
  | { type: 'widget'; definition: unknown; title?: string }
  | { type: 'image'; src: string; alt?: string; title?: string }
  | { type: 'browser'; url: string; title?: string };
