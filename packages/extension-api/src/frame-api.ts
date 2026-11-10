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
export interface FrameExtensionAPI extends Omit<ExtensionAPI, 'executeCommand' | 'openCanvas'> {
  /** Activation runs once for registrations and once per mounted view. Keep startup work in registration. */
  readonly context: 'registration' | 'view';
  /** Request JSON from this app's own server router. Requires capabilities.http. */
  request<T = unknown>(
    path: string,
    options?: {
      method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
      body?: unknown;
    }
  ): Promise<T>;
  /** Read this app's non-secret manifest settings. */
  readonly settings: { get<T = unknown>(): Promise<T> };
  /**
   * Put text, data, a widget, a picture or a web page on the canvas. A page
   * must be `http:` or `https:`, and its tab names this app. Files, PDFs,
   * diffs and MCP apps are refused.
   */
  openCanvas(content: FrameCanvasContent): Promise<void>;
  /**
   * Offer to save a file. DorkOS asks the person ("<App> wants to save
   * <name>"), then saves it as a plain download. Types that run or install
   * when opened are refused, as is a file over 10 MB.
   *
   * @returns `saved` when the person chose Save, `dismissed` otherwise.
   */
  download(file: { name: string; content: string }): Promise<'saved' | 'dismissed'>;
}

/** What {@link FrameExtensionAPI.openCanvas} accepts. */
export type FrameCanvasContent =
  | { type: 'markdown'; content: string; title?: string }
  | { type: 'json'; data: unknown; title?: string }
  | { type: 'widget'; definition: unknown; title?: string }
  | { type: 'image'; src: string; alt?: string; title?: string }
  | { type: 'browser'; url: string; title?: string };
