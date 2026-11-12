import {
  type ExtensionAPI,
  type ExtensionManifest,
  type ExtensionPointId,
} from '@dorkos/extension-api';
import { z } from 'zod';
import runtime from 'virtual:dorkos-extension-frame';
import { resolveApiBaseUrl } from '@/layers/shared/lib';
import {
  args,
  FrameCallSchema,
  json,
  text,
  type FrameRegistration,
  type FrameTheme,
} from './protocol';
import { AppRequestFailure } from './app-request';

/** The sandbox grants scripts only: no origin, popups, downloads, forms, or parent navigation. */
export const EXTENSION_FRAME_SANDBOX = 'allow-scripts';
/**
 * The document every app's screens run in. Served by DorkOS with its own CSP
 * (sandboxed, nonce-only scripts, no network); see `routes/extension-frame.ts`.
 * Never a `srcdoc` frame, which would inherit the app shell's policy.
 */
export const EXTENSION_FRAME_PATH = '/extension-frame';
const TIMEOUT_MS = 15_000;
/** Every placement a frame may ask about; the host answers which ones it has. */
const FRAME_SLOTS: ExtensionPointId[] = [
  'sidebar.footer',
  'dashboard.sections',
  'command-palette.items',
  'dialog',
  'settings.tabs',
  'right-panel',
  'status-bar',
];

/**
 * How a view sizes itself: `fill` takes its slot (pages, the right panel,
 * dialogs); `height` grows to what it drew (Activity sections, Settings tabs);
 * `both` fits its content in each direction (status-bar items).
 */
export type FrameFit = 'fill' | 'height' | 'both';

/** What a view drew, in CSS pixels. Zero height means it drew nothing. */
export interface FrameSize {
  width: number;
  height: number;
}

/** A size report from a frame: bounded, so a frame cannot ask for a huge box. */
const FrameSizeSchema = z
  .object({
    type: z.literal('size'),
    width: z.number().finite().min(0).max(4000),
    height: z.number().finite().min(0).max(20_000),
  })
  .strict();

/** How a registration's view sizes itself in the slot it was placed in. */
export function frameFit(reg: FrameRegistration): FrameFit {
  if (reg.kind === 'status') return 'both';
  if (reg.kind === 'settings') return 'height';
  if (reg.kind === 'component' && reg.slot !== 'right-panel') return 'height';
  return 'fill';
}

export interface FrameConnection {
  ready: Promise<void>;
  /** The `<iframe>` this connection created: where the app's own input lands. */
  element: HTMLIFrameElement;
  send(message: unknown): void;
  setProps(props: unknown): void;
  close(): void;
}
interface FrameOptions {
  code: string;
  manifest: ExtensionManifest;
  api: ExtensionAPI;
  parent: HTMLElement;
  selectedView: string | null;
  props: unknown;
  /** How the view sizes itself in its slot. */
  fit: FrameFit;
  /** Told the size of what the view drew, so an empty view takes no space. */
  onSize?(size: FrameSize): void;
  onClose(): void;
  invoke(
    method: string,
    args: unknown[],
    events: {
      subscribe(key: string, make: () => () => void): null;
      unsubscribe(key: string): null;
      send(key: string, data: unknown): void;
    }
  ): Promise<unknown>;
}

/** The host root's classes and inline style, which carry light or dark mode and the font choice. */
function hostTheme(): FrameTheme {
  const root = document.documentElement;
  return { className: root.className, style: root.getAttribute('style') ?? '' };
}

/** Create an opaque document and give it one private, revocable host connection. */
export function createFrameConnection(options: FrameOptions): FrameConnection {
  const iframe = document.createElement('iframe');
  iframe.title = options.manifest.name;
  iframe.setAttribute('sandbox', EXTENSION_FRAME_SANDBOX);
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.className = 'block h-full w-full border-0';
  iframe.src = resolveApiBaseUrl() + EXTENSION_FRAME_PATH;
  const channel = new MessageChannel();
  let closed = false;
  let initialized = false;
  let callbackSeq = 0;
  let inflight = 0;
  let callbacks = new Map<string, (...args: unknown[]) => unknown>();
  const subscriptions = new Map<string, () => void>();
  let rejectReady: (error: Error) => void = () => {};
  let timeout: ReturnType<typeof setTimeout>;
  const send = (message: unknown) => {
    if (!closed) channel.port1.postMessage(message);
  };
  function encode(value: unknown): unknown {
    if (typeof value === 'function') {
      const id = `prop:${++callbackSeq}`;
      callbacks.set(id, value as (...args: unknown[]) => unknown);
      return { $callback: id };
    }
    if (Array.isArray(value)) return value.map(encode);
    if (value && typeof value === 'object')
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encode(v)]));
    return value;
  }
  const ready = new Promise<void>((resolve, reject) => {
    rejectReady = reject;
    timeout = setTimeout(() => {
      connection.close();
      reject(new Error('The app took too long to start.'));
    }, TIMEOUT_MS);
    channel.port1.onmessage = async ({ data }) => {
      if (closed) return;
      if (data?.type === 'size') {
        const parsed = FrameSizeSchema.safeParse(data);
        if (parsed.success)
          options.onSize?.({ width: parsed.data.width, height: parsed.data.height });
        return;
      }
      if (data?.type === 'ready') {
        clearTimeout(timeout);
        resolve();
        return;
      }
      if (data?.type === 'failed') {
        connection.close();
        reject(new Error('The app could not start.'));
        return;
      }
      const parsed = FrameCallSchema.safeParse(data);
      if (!parsed.success) return;
      const { extensionId, requestId, method, args: input } = parsed.data;
      if (extensionId !== options.api.id || inflight >= 32) {
        send({ type: 'reply', requestId, error: 'This request was refused.' });
        return;
      }
      inflight++;
      try {
        let value: unknown;
        if (method === 'callback') {
          const [key, values] = args(text, z.array(json).max(8)).parse(input);
          const callback = callbacks.get(key);
          if (!callback) throw new Error('That control is no longer available.');
          value = await callback(...values);
        } else
          value = await options.invoke(method, input, {
            subscribe(key, make) {
              subscriptions.get(key)?.();
              subscriptions.set(key, make());
              return null;
            },
            unsubscribe(key) {
              subscriptions.get(key)?.();
              subscriptions.delete(key);
              return null;
            },
            send(key, event) {
              send({ type: 'event', key, args: [event] });
            },
          });
        send({ type: 'reply', requestId, value: value ?? null });
      } catch (error) {
        // Errors from the host contain no paths or objects for a bundle to inspect.
        // Only the app's own route failing hands back what that route said:
        // its status and body, never its reply headers.
        send({
          type: 'reply',
          requestId,
          error: 'This app request was refused or failed.',
          ...(error instanceof AppRequestFailure
            ? { failure: { status: error.status, body: error.body } }
            : {}),
        });
      } finally {
        inflight--;
      }
    };
    channel.port1.start();
  });
  const unsubState = options.api.subscribe(
    (state) => state,
    (state) => send({ type: 'state', state })
  );
  // A theme or font change on the host reaches every open frame.
  const themeWatch = new MutationObserver(() => send({ type: 'theme', theme: hostTheme() }));
  themeWatch.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'style'],
  });
  iframe.onload = () => {
    if (closed) return;
    // A navigation loses its port; never give a replacement document another one.
    if (initialized) {
      connection.close();
      return;
    }
    initialized = true;
    // The page runs only its own bootstrap; it takes the runtime once, from us.
    iframe.contentWindow?.postMessage({ type: 'dorkos-frame-runtime', runtime }, '*');
    const css = Array.from(document.styleSheets)
      .map((sheet) => {
        try {
          return Array.from(sheet.cssRules)
            .map((rule) => rule.cssText)
            .join('\n');
        } catch {
          return '';
        }
      })
      .join('\n');
    iframe.contentWindow?.postMessage(
      {
        type: 'initialize',
        init: {
          extensionId: options.api.id,
          code: options.code,
          state: options.api.getState(),
          slots: FRAME_SLOTS.filter((slot) => options.api.isSlotAvailable(slot)),
          view: options.selectedView,
          fit: options.fit,
          props: encode(options.props),
          css,
          theme: hostTheme(),
        },
      },
      '*',
      [channel.port2]
    );
  };
  const connection: FrameConnection = {
    ready,
    element: iframe,
    send,
    setProps(props) {
      callbacks = new Map();
      send({ type: 'props', props: encode(props) });
    },
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(timeout);
      unsubState();
      themeWatch.disconnect();
      options.onClose();
      for (const stop of subscriptions.values()) stop();
      subscriptions.clear();
      callbacks.clear();
      channel.port1.close();
      channel.port2.close();
      iframe.remove();
      rejectReady(new Error('This app has stopped.'));
    },
  };
  options.parent.append(iframe);
  return connection;
}
