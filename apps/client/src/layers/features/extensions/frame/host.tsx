import { createElement, useEffect, useRef, type ReactElement } from 'react';
import {
  EXTENSION_EVENT_KINDS as SDK_EVENT_KINDS,
  type ExtensionAPI,
  type ExtensionManifest,
  type ExtensionModule,
  type ExtensionPointId,
} from '@dorkos/extension-api';
import { z } from 'zod';
import runtime from 'virtual:dorkos-extension-frame';
import { extensionApiUrl } from '../model/extension-api-url';
import {
  FrameCallSchema,
  FrameRegistrationSchema,
  type FrameRegistration,
  type FrameTheme,
} from './protocol';

/** The sandbox grants scripts only: no origin, popups, downloads, forms, or parent navigation. */
export const EXTENSION_FRAME_SANDBOX = 'allow-scripts';
/** No frame resource can contact DorkOS or an outside account directly. */
export const EXTENSION_FRAME_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'";
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
// Zod overloads empty and nonempty tuples separately; this preserves the inferred tuple for both.
const args = <const T extends [] | [z.ZodType, ...z.ZodType[]]>(...schemas: T): z.ZodTuple<T> =>
  z.tuple(schemas as []) as unknown as z.ZodTuple<T>;
const text = z.string().max(4000);
const json = z.json();
const methodArgs: Record<string, z.ZodType> = {
  loadData: args(),
  saveData: args(json),
  notify: args(
    text,
    z
      .object({ type: z.enum(['info', 'success', 'error']).optional() })
      .strict()
      .optional()
  ),
  navigate: args(text),
  setPageBadge: args(text, json),
  setTabMarker: args(text, z.enum(['attention']).nullable()),
  listDecisions: args(),
  answerDecision: args(text, json),
  startWork: args(json),
  'projectSettings.get': args(text),
  'projectSettings.set': args(text, json),
  'rooms.listRooms': args(),
  'rooms.readThread': args(text, text),
  'rooms.reply': args(text, text, z.string().min(1).max(20_000)),
  'rooms.unreadCounts': args(text, z.array(text).max(100)),
  'rooms.markRead': args(text, text),
  'forward.agents': args(),
  'forward.send': args(json),
  'forward.replies': args(text),
  'forward.stamps': args(z.array(text).max(50)),
};

/** Validate a relative app route before constructing an authority-bearing host request. */
export function extensionRequestPath(id: string, path: string): string {
  const [pathname] = path.split('?');
  if (!/^\/(?:[a-zA-Z0-9_-]+\/?)*$/.test(pathname) || path.includes('#') || path.length > 4000) {
    throw new Error('Use a path inside this app.');
  }
  return `/ext/${encodeURIComponent(id)}${path}`;
}

/** Start one isolated module; only its data and trusted React wrappers reach the registry. */
export function isolatedExtensionModule(
  code: string,
  manifest: ExtensionManifest
): ExtensionModule {
  return {
    async activate(api) {
      const registrations = new Map<string, () => void>();
      const dialogs = new Map<string, { open(): void; close(): void }>();
      const frames = new Set<FrameConnection>();
      let disposed = false;
      let controller: FrameConnection;
      const close = () => {
        disposed = true;
        for (const frame of frames) frame.close();
        for (const remove of registrations.values()) remove();
        registrations.clear();
        dialogs.clear();
      };
      function view(key: string): (props: object) => ReactElement {
        return function IsolatedView(props: object) {
          const container = useRef<HTMLDivElement>(null);
          const connection = useRef<FrameConnection | null>(null);
          // The frame starts once with the props of its first render; later
          // props travel over the bridge instead of rebuilding the frame.
          const sentProps = useRef<object>(props);
          useEffect(() => {
            if (!container.current || disposed) return;
            const frame = connect(container.current, key, sentProps.current);
            connection.current = frame;
            void frame.ready.catch(() => {
              if (container.current)
                container.current.textContent = 'This app could not open. Try again in Settings.';
            });
            return () => {
              frame.close();
              connection.current = null;
            };
          }, []);
          useEffect(() => {
            if (sentProps.current === props) return;
            sentProps.current = props;
            connection.current?.setProps(props);
          }, [props]);
          return createElement('div', {
            ref: container,
            className: 'h-full min-h-8 w-full',
            'data-slot': 'extension-frame',
          });
        };
      }
      function register(reg: FrameRegistration): void {
        registrations.get(reg.key)?.();
        const component = view(reg.key);
        const options = reg.options ?? {};
        switch (reg.kind) {
          case 'component': {
            if (!reg.slot) throw new Error('Name a supported app placement.');
            const { icon: _icon, ...componentOptions } = options;
            registrations.set(
              reg.key,
              api.registerComponent(reg.slot, reg.id, component, componentOptions)
            );
            break;
          }
          case 'page':
            registrations.set(
              reg.key,
              api.registerPage(reg.id, component, {
                title: options.title ?? '',
                menu: options.menu,
              })
            );
            break;
          case 'settings':
            registrations.set(
              reg.key,
              api.registerSettingsTab(reg.id, reg.label ?? reg.id, component, {
                group: options.group,
              })
            );
            break;
          case 'status':
            registrations.set(
              reg.key,
              api.registerStatusBarItem(reg.id, component, {
                label: options.label ?? reg.id,
                priority: options.priority,
              })
            );
            break;
          case 'command':
            registrations.set(
              reg.key,
              api.registerCommand(
                reg.id,
                reg.label ?? reg.id,
                () => controller.send({ type: 'event', key: reg.key, args: [] }),
                { icon: options.icon, shortcut: options.shortcut }
              )
            );
            break;
          case 'dialog':
            dialogs.set(reg.key, api.registerDialog(reg.id, component));
            break;
        }
      }
      function connect(
        parent: HTMLElement,
        selectedView: string | null,
        props: unknown
      ): FrameConnection {
        const frame = createFrameConnection({
          code,
          manifest,
          api,
          parent,
          selectedView,
          props,
          onClose: () => frames.delete(frame),
          async invoke(method, input, emit) {
            if (disposed) throw new Error('This app has stopped.');
            if (method === 'register') {
              if (selectedView !== null) throw new Error('Views cannot add host placements.');
              register(FrameRegistrationSchema.parse(input[0]));
              return null;
            }
            if (method === 'unregister') {
              if (selectedView !== null) throw new Error('Views cannot remove host placements.');
              const [key] = args(text).parse(input);
              registrations.get(key)?.();
              registrations.delete(key);
              return null;
            }
            if (method === 'dialog') {
              const [key, open] = args(text, z.boolean()).parse(input);
              const controls = dialogs.get(key);
              if (!controls) throw new Error('This app did not register that dialog.');
              if (open) controls.open();
              else controls.close();
              return null;
            }
            if (method === 'request') {
              if (!manifest.capabilities?.http)
                throw new Error('This app has not declared server requests.');
              const [path, options] = args(
                text,
                z
                  .object({
                    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
                    body: json.optional(),
                  })
                  .strict()
              ).parse(input);
              const response = await fetch(extensionApiUrl(extensionRequestPath(api.id, path)), {
                method: options.method,
                headers: { 'Content-Type': 'application/json', 'X-DorkOS-Extension': api.id },
                ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
              });
              if (!response.ok) throw new Error(`The app request failed (${response.status}).`);
              return response.status === 204 ? null : response.json();
            }
            if (method === 'settings.get') {
              args().parse(input);
              const response = await fetch(
                extensionApiUrl(`/extensions/${encodeURIComponent(api.id)}/settings`)
              );
              if (!response.ok) throw new Error('The app settings could not be read.');
              return response.json();
            }
            if (method === 'rooms.subscribeThread') {
              if (!manifest.capabilities?.rooms)
                throw new Error('This app has not declared rooms.');
              const [roomId, rootId, key] = args(text, text, text).parse(input);
              return emit.subscribe(key, () =>
                api.rooms.subscribeThread(roomId, rootId, (entry) => emit.send(key, entry))
              );
            }
            if (method === 'events.subscribe') {
              const [kinds, key] = args(z.array(z.enum(SDK_EVENT_KINDS)), text).parse(input);
              return emit.subscribe(key, () =>
                api.events.subscribe(kinds, (event) => emit.send(key, event))
              );
            }
            if (method === 'events.unsubscribe') {
              const [key] = args(text).parse(input);
              return emit.unsubscribe(key);
            }
            if (method.startsWith('forward.') && !manifest.capabilities?.forward)
              throw new Error('This app has not declared forwarding.');
            // Own keys only: `constructor` or `__proto__` must never resolve to a schema.
            const schema = Object.hasOwn(methodArgs, method) ? methodArgs[method] : undefined;
            if (!schema) throw new Error('This operation is not available to apps.');
            if (method.startsWith('rooms.') && !manifest.capabilities?.rooms)
              throw new Error('This app has not declared rooms.');
            const checked = schema.parse(input) as unknown[];
            const [group, leaf] = method.split('.');
            const owner = leaf
              ? (api as unknown as Record<string, Record<string, unknown>>)[group]
              : api;
            const fn = (owner as unknown as Record<string, unknown>)[leaf ?? group];
            if (typeof fn !== 'function') throw new Error('This operation is unavailable.');
            return Reflect.apply(fn, owner, checked) as unknown;
          },
        });
        frames.add(frame);
        return frame;
      }
      const hidden = document.createElement('div');
      try {
        hidden.hidden = true;
        document.body.append(hidden);
        controller = connect(hidden, null, {});
        await controller.ready;
        return () => {
          close();
          hidden.remove();
        };
      } catch (error) {
        close();
        hidden.remove();
        throw error;
      }
    },
  };
}

interface FrameConnection {
  ready: Promise<void>;
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
function createFrameConnection(options: FrameOptions): FrameConnection {
  const iframe = document.createElement('iframe');
  iframe.title = options.manifest.name;
  iframe.setAttribute('sandbox', EXTENSION_FRAME_SANDBOX);
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.className = 'h-full min-h-8 w-full border-0';
  iframe.srcdoc = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${EXTENSION_FRAME_CSP}"><div id="root"></div><script>${runtime.replace(/<\/script/gi, '<\\/script')}</script>`;
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
      } catch {
        // Errors from the host contain no paths or objects for a bundle to inspect.
        send({ type: 'reply', requestId, error: 'This app request was refused or failed.' });
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
