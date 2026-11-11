/** This module is bundled into a separate script and runs only in an opaque frame. */
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as ReactClient from 'react-dom/client';
import * as JsxRuntime from 'react/jsx-runtime';
import * as Sdk from '@dorkos/extension-api';
import type { ExtensionAPI } from '@dorkos/extension-api';
import type { FrameInit, FrameRegistration, FrameTheme } from './protocol';

type Callback = (...args: unknown[]) => unknown;
type View = {
  component: React.ComponentType<Record<string, unknown>>;
  options?: Record<string, unknown>;
};

// No host objects are shared: these are the frame's own copies of React and the SDK.
// The bundle is a classic script (the frame inherits the shell CSP, which runs
// inline scripts but no blob: module), so its externals resolve through `require`.
const globals = globalThis as unknown as Record<string, unknown>;
globals.React = React;
const externals: Record<string, unknown> = {
  react: React,
  'react-dom': ReactDOM,
  'react-dom/client': ReactClient,
  'react/jsx-runtime': JsxRuntime,
  'react/jsx-dev-runtime': JsxRuntime,
  '@dorkos/extension-api': Sdk,
};
globals.require = (name: string) => {
  if (!Object.hasOwn(externals, name)) throw new Error(`Apps cannot load "${name}".`);
  return externals[name];
};

/** Run the bundle as an inline script and return the exports it assigned. */
function evaluateBundle(code: string): { activate?: (api: ExtensionAPI) => unknown } {
  let thrown: unknown;
  const onError = (event: ErrorEvent) => {
    thrown = event.error ?? new Error(event.message);
    event.preventDefault();
  };
  window.addEventListener('error', onError);
  const script = document.createElement('script');
  // The frame page runs only scripts carrying its nonce, which its bootstrap kept for us.
  script.nonce = (globalThis as { __dorkosFrameNonce?: string }).__dorkosFrameNonce ?? '';
  script.textContent = `${code}\n;globalThis[${JSON.stringify(Sdk.EXTENSION_BUNDLE_GLOBAL)}] = ${Sdk.EXTENSION_BUNDLE_GLOBAL};`;
  document.head.append(script);
  script.remove();
  window.removeEventListener('error', onError);
  if (thrown) throw thrown;
  const exports = globals[Sdk.EXTENSION_BUNDLE_GLOBAL];
  if (!exports || typeof exports !== 'object') throw new Error('The app bundle exported nothing.');
  return exports as { activate?: (api: ExtensionAPI) => unknown };
}

window.addEventListener('message', function initialize(event: MessageEvent) {
  // Only the window, and the exact origin, that handed the bootstrap this runtime.
  const parentOrigin = (globalThis as { __dorkosFrameParentOrigin?: string })
    .__dorkosFrameParentOrigin;
  if (event.source !== parent || parentOrigin === undefined || event.origin !== parentOrigin)
    return;
  if (event.data?.type !== 'initialize' || event.ports.length !== 1) return;
  window.removeEventListener('message', initialize);
  void start(event.data.init as FrameInit, event.ports[0]);
});

/** Mirror the host's light or dark mode and font choice onto this document. */
function applyTheme(theme: FrameTheme): void {
  document.documentElement.className = theme.className;
  document.documentElement.setAttribute('style', theme.style);
}

/** Activate code and render its selected view without handing it any host reference. */
async function start(init: FrameInit, port: MessagePort): Promise<void> {
  let seq = 0;
  let state = init.state;
  let currentProps = init.props;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const callbacks = new Map<string, Callback>();
  const views = new Map<string, View>();
  const registrations: Promise<unknown>[] = [];
  const style = document.createElement('style');
  // A view that fills its slot stretches to it; one that fits its content is
  // measured, so the host can size the frame to it (or hide it when empty).
  const layout =
    init.fit === 'fill'
      ? 'html,body,#root{margin:0;width:100%;min-height:100%;}'
      : init.fit === 'both'
        ? 'html,body{margin:0;}#root{display:inline-block;}'
        : 'html,body{margin:0;width:100%;}#root{display:flow-root;}';
  style.textContent = `${init.css}\n${layout}body{background:transparent}`;
  document.head.append(style);
  applyTheme(init.theme);

  function call(method: string, ...args: unknown[]): Promise<unknown> {
    const requestId = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      port.postMessage({ type: 'call', extensionId: init.extensionId, requestId, method, args });
    });
  }
  function decode(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(decode);
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (typeof record.$callback === 'string') {
        return (...args: unknown[]) => void call('callback', record.$callback, args);
      }
      return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, decode(v)]));
    }
    return value;
  }
  port.onmessage = ({ data }) => {
    if (data.type === 'reply') {
      const request = pending.get(data.requestId);
      if (!request) return;
      pending.delete(data.requestId);
      if (data.error) {
        // A failed route answer rejects with its status and body; anything else
        // with a plain message.
        const failure = data.failure as { status: number; body: unknown } | undefined;
        request.reject(
          failure
            ? Object.assign(new Error(`The app request failed (${failure.status}).`), failure)
            : new Error(data.error)
        );
      } else request.resolve(data.value);
    } else if (data.type === 'event') {
      callbacks.get(data.key)?.(...data.args);
    } else if (data.type === 'state') {
      state = data.state;
      for (const [key, cb] of callbacks) if (key.startsWith('state:')) cb(state);
    } else if (data.type === 'theme') {
      applyTheme(data.theme as FrameTheme);
    } else if (data.type === 'props') {
      currentProps = data.props;
      render(currentProps);
    }
  };
  port.start();
  const rootElement = document.getElementById('root')!;
  const root = ReactClient.createRoot(rootElement);
  let lastSize = '';
  /** Tell the host how big the view's drawing is; an empty view is 0×0. */
  function reportSize(): void {
    const empty = rootElement.childNodes.length === 0;
    const box = rootElement.getBoundingClientRect();
    const size = empty
      ? { width: 0, height: 0 }
      : { width: Math.ceil(box.width), height: Math.max(1, Math.ceil(box.height)) };
    const key = `${size.width}x${size.height}`;
    if (key === lastSize) return;
    lastSize = key;
    port.postMessage({ type: 'size', ...size });
  }
  if (init.view !== null) {
    new ResizeObserver(reportSize).observe(rootElement);
    new MutationObserver(reportSize).observe(rootElement, { childList: true, subtree: true });
  }
  function render(props: unknown): void {
    const view = init.view && views.get(init.view);
    if (!view) return;
    const decoded = decode(props) as Record<string, unknown>;
    const when = view.options?.when;
    const visible = view.options?.visibleWhen;
    const show =
      (typeof when !== 'function' || when(decoded)) && (typeof visible !== 'function' || visible());
    root.render(show ? React.createElement(view.component, decoded) : null);
  }
  function register(
    kind: FrameRegistration['kind'],
    id: string,
    component: unknown,
    options?: Record<string, unknown>,
    slot?: FrameRegistration['slot'],
    label?: string
  ): () => void {
    const key = `${kind}:${slot ?? ''}:${id}`;
    if (typeof component === 'function' || (component && typeof component === 'object')) {
      views.set(key, { component: component as View['component'], options });
    }
    // Icons and predicates stay executable only in this frame.
    const safeOptions =
      options &&
      Object.fromEntries(
        Object.entries(options).filter(
          ([k, v]) =>
            !['when', 'urgent', 'visibleWhen'].includes(k) &&
            typeof v !== 'function' &&
            (k !== 'icon' || typeof v === 'string')
        )
      );
    if (init.view === null)
      registrations.push(
        call('register', {
          kind,
          key,
          id,
          ...(slot ? { slot } : {}),
          ...(label ? { label } : {}),
          ...(safeOptions ? { options: safeOptions } : {}),
        })
      );
    return () => {
      views.delete(key);
      if (init.view === null) void call('unregister', key);
    };
  }
  const api = {
    id: init.extensionId,
    context: init.view === null ? 'registration' : 'view',
    registerComponent: (
      slot: FrameRegistration['slot'],
      id: string,
      view: unknown,
      options?: Record<string, unknown>
    ) => register('component', id, view, options, slot),
    registerPage: (path: string, view: unknown, options: Record<string, unknown>) =>
      register('page', path, view, options),
    registerSettingsTab: (
      id: string,
      label: string,
      view: unknown,
      options?: Record<string, unknown>
    ) => register('settings', id, view, options, undefined, label),
    registerStatusBarItem: (id: string, view: unknown, options: Record<string, unknown>) =>
      register('status', id, view, options),
    registerCommand: (
      id: string,
      label: string,
      callback: Callback,
      options?: Record<string, unknown>
    ) => {
      const key = `command::${id}`;
      callbacks.set(key, callback);
      return register('command', id, null, options, undefined, label);
    },
    registerDialog: (id: string, view: unknown) => {
      register('dialog', id, view);
      return {
        open: () => void call('dialog', `dialog::${id}`, true),
        close: () => void call('dialog', `dialog::${id}`, false),
      };
    },
    getState: () => state,
    isSlotAvailable: (slot: string) => init.slots.includes(slot),
    subscribe: (selector: (s: unknown) => unknown, callback: Callback) => {
      let current = selector(state);
      const key = `state:${++seq}`;
      callbacks.set(key, (next) => {
        const value = selector(next);
        if (!Object.is(current, value)) {
          current = value;
          callback(value);
        }
      });
      return () => {
        callbacks.delete(key);
      };
    },
    events: {
      subscribe: (kinds: string[], callback: Callback) => {
        const key = `event:${++seq}`;
        callbacks.set(key, callback);
        void call('events.subscribe', kinds, key);
        return () => {
          callbacks.delete(key);
          void call('events.unsubscribe', key);
        };
      },
    },
    projectSettings: {
      get: (root: string) => call('projectSettings.get', root),
      set: (root: string, value: unknown) => call('projectSettings.set', root, value),
    },
    settings: { get: () => call('settings.get') },
    request: (path: string, options?: unknown) => call('request', path, options ?? {}),
    media: (path: string) => call('media', path),
  } as unknown as ExtensionAPI;
  for (const method of [
    'loadData',
    'saveData',
    'notify',
    'navigate',
    'setPageBadge',
    'setTabMarker',
    'answerDecision',
    'listDecisions',
    'startWork',
    'openCanvas',
    'download',
  ] as const) {
    Object.assign(api, { [method]: (...args: unknown[]) => call(method, ...args) });
  }
  Object.assign(api, {
    rooms: {
      ...Object.fromEntries(
        ['listRooms', 'readThread', 'reply', 'unreadCounts', 'markRead'].map((method) => [
          method,
          (...args: unknown[]) => call(`rooms.${method}`, ...args),
        ])
      ),
      subscribeThread: (roomId: string, rootId: string, callback: Callback) => {
        const key = `thread:${++seq}`;
        callbacks.set(key, callback);
        void call('rooms.subscribeThread', roomId, rootId, key);
        return () => {
          callbacks.delete(key);
          void call('events.unsubscribe', key);
        };
      },
    },
    forward: Object.fromEntries(
      ['agents', 'send', 'replies', 'stamps'].map((method) => [
        method,
        (...args: unknown[]) => call(`forward.${method}`, ...args),
      ])
    ),
  });
  try {
    const module = evaluateBundle(init.code);
    if (typeof module.activate !== 'function') throw new Error('The app has no activate().');
    const cleanup = await module.activate(api);
    await Promise.all(registrations);
    render(currentProps);
    port.postMessage({ type: 'ready' });
    // After React's first commit, so a view that draws nothing still says so.
    if (init.view !== null) requestAnimationFrame(reportSize);
    window.addEventListener('pagehide', () => {
      if (typeof cleanup === 'function') cleanup();
      root.unmount();
      port.close();
    });
  } catch (error) {
    port.postMessage({
      type: 'failed',
      message: error instanceof Error ? error.message : 'The app could not start.',
    });
  }
}
