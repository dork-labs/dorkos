import { createElement, useEffect, useRef, useState, type ReactElement } from 'react';
import {
  EXTENSION_EVENT_KINDS as SDK_EVENT_KINDS,
  type ExtensionAPI,
  type ExtensionManifest,
  type ExtensionModule,
  type ExtensionPointId,
} from '@dorkos/extension-api';
import { z } from 'zod';
import { extensionApiUrl } from '../model/extension-api-url';
import { offerAppDownload } from './download';
import {
  EXTENSION_FRAME_PATH,
  EXTENSION_FRAME_SANDBOX,
  createFrameConnection,
  frameFit,
  type FrameConnection,
  type FrameFit,
  type FrameSize,
} from './connection';
import {
  args,
  FrameCanvasContentSchema,
  FrameDownloadSchema,
  FrameRegistrationSchema,
  json,
  text,
  type FrameRegistration,
} from './protocol';

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
      function view(key: string, fit: FrameFit): (props: object) => ReactElement {
        return function IsolatedView(props: object) {
          const container = useRef<HTMLDivElement>(null);
          const connection = useRef<FrameConnection | null>(null);
          // Hidden until the frame has drawn something: an app with nothing to
          // show leaves no frame at all, never a small empty one.
          const [size, setSize] = useState<FrameSize | null>(null);
          const [failed, setFailed] = useState(false);
          // The frame starts once with the props of its first render; later
          // props travel over the bridge instead of rebuilding the frame.
          const sentProps = useRef<object>(props);
          useEffect(() => {
            if (!container.current || disposed) return;
            const frame = connect(container.current, key, sentProps.current, fit, setSize);
            connection.current = frame;
            // Our own close also rejects `ready`; only a frame that failed on its own says so.
            let mounted = true;
            void frame.ready.catch(() => {
              if (mounted) setFailed(true);
            });
            return () => {
              mounted = false;
              frame.close();
              connection.current = null;
            };
          }, []);
          useEffect(() => {
            if (sentProps.current === props) return;
            sentProps.current = props;
            connection.current?.setProps(props);
          }, [props]);
          if (failed) {
            return createElement(
              'p',
              { className: 'text-muted-foreground p-2 text-sm' },
              'This app could not open. Try again in Settings.'
            );
          }
          const shown = size !== null && size.height > 0;
          // Zero height, not display:none, so the frame keeps laying out and can
          // say when it has something to show.
          const style = !shown
            ? { height: 0, overflow: 'hidden' }
            : fit === 'fill'
              ? undefined
              : { height: size.height, ...(fit === 'both' ? { width: size.width } : {}) };
          return createElement('div', {
            ref: container,
            'aria-hidden': shown ? undefined : true,
            className:
              fit === 'both' ? 'inline-block' : fit === 'fill' ? 'h-full w-full' : 'w-full',
            style,
            'data-slot': 'extension-frame',
          });
        };
      }
      function register(reg: FrameRegistration): void {
        registrations.get(reg.key)?.();
        const component = view(reg.key, frameFit(reg));
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
        props: unknown,
        fit: FrameFit = 'fill',
        onSize?: (size: FrameSize) => void
      ): FrameConnection {
        const frame = createFrameConnection({
          code,
          manifest,
          api,
          parent,
          selectedView,
          props,
          fit,
          onSize,
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
            if (method === 'openCanvas') {
              const [content] = args(FrameCanvasContentSchema).parse(input);
              // A page an app opens says which app opened it, in the tab's title.
              api.openCanvas(
                content.type === 'browser'
                  ? {
                      type: 'browser',
                      url: content.url,
                      title: `${manifest.name}: ${content.title ?? content.url}`,
                    }
                  : content
              );
              return null;
            }
            if (method === 'download') {
              const [file] = args(FrameDownloadSchema).parse(input);
              return offerAppDownload(manifest.name, file);
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

export { EXTENSION_FRAME_PATH, EXTENSION_FRAME_SANDBOX };
