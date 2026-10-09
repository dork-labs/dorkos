import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  resolveInstalledRuntimeConfiguration,
  verifyInstalledNativeJournal,
} from '@dorkos/browser/runtime-installation';
import {
  BrowserProductionOpenReceiptSchema,
  BrowserControlSchema,
  BrowserLocalDestinationReceiptSchema,
  BrowserProductionNavigateReceiptSchema,
  BrowserCopySelectionReceiptSchema,
  BrowserCloseReceiptSchema,
} from '@dorkos/shared/browser-schemas';
import { withOriginalInstalledBrowserRound } from './private-storage-runner.fixture.js';
import { verifyPublicNativeEmits, type PublicNativeInput } from './public-native-input.js';

/** Automatic native selection/password checks. It never reads or writes any OS clipboard. */
export async function runOriginalSelectionCopyWindow(options: {
  input: PublicNativeInput;
  node: string;
  artifacts: string;
  signal: AbortSignal;
  current(): void;
  retain(report: unknown): Promise<void>;
  retainRetirement?: (report: unknown) => Promise<void>;
}) {
  const retain = options.retain.bind(options),
    retainRetirement = options.retainRetirement?.bind(options);
  const current = () => {
    options.current();
    options.signal.throwIfAborted();
  };
  await verifyPublicNativeEmits(options.input, current);
  const configuration = await resolveInstalledRuntimeConfiguration(
      pathToFileURL(options.input.cliEntry),
      options.input.home
    ),
    native = await verifyInstalledNativeJournal(configuration);
  current();
  const sockets = new Map<Socket, Promise<void>>();
  let first: { value: unknown } | undefined;
  let closing: Promise<void> | undefined;
  const ready = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  for (const kind of ['ordinary', 'password']) {
    let resolve!: () => void;
    const promise = new Promise<void>((yes) => {
      resolve = yes;
    });
    ready.set(kind, { promise, resolve });
  }
  const server = createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/ordinary' || req.url === '/password')) {
      const kind = req.url.slice(1);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(
        `<!doctype html><meta charset="utf-8"><title>Selection copy control</title><input type="${kind === 'password' ? 'password' : 'text'}" autocomplete="off" value="${kind === 'password' ? 'fixture-only-password' : 'ordinary selection'}"><script>const field=document.querySelector('input');field.focus();field.setSelectionRange(0,8);fetch('/ready/${kind}',{method:'POST'});</script>`
      );
      return;
    }
    const marker = req.url?.slice('/ready/'.length);
    if (req.method === 'POST' && req.url?.startsWith('/ready/') && marker && ready.has(marker)) {
      ready.get(marker)!.resolve();
      res.writeHead(204).end();
      return;
    }
    res.writeHead(404).end();
  });
  let closeServer: Promise<void> | undefined;
  const fence = () => {
    if (!closeServer) {
      let yes!: () => void, no!: (value: unknown) => void;
      closeServer = new Promise<void>((resolve, reject) => {
        yes = resolve;
        no = reject;
      });
      void closeServer.catch(() => undefined);
      try {
        server.close((error) => {
          if (error) no(error);
          else yes();
        });
      } catch (value) {
        no(value);
      }
    }
    for (const socket of sockets.keys())
      try {
        socket.destroy();
      } catch (value) {
        first ??= { value };
      }
  };
  const close = () => {
    if (closing) return closing;
    let yes!: () => void, no!: (value: unknown) => void;
    closing = new Promise<void>((resolve, reject) => {
      yes = resolve;
      no = reject;
    });
    void closing.catch(() => undefined);
    fence();
    void (async () => {
      const originals = [...sockets.values(), ...(closeServer ? [closeServer] : [])];
      for (const result of await Promise.allSettled(originals))
        if (result.status === 'rejected') first ??= { value: result.reason };
      options.signal.removeEventListener('abort', fence);
      if (first) no(first.value);
      else yes();
    })();
    return closing;
  };
  server.on('connection', (socket) => {
    let resolve!: () => void;
    const terminal = new Promise<void>((yes) => {
      resolve = yes;
    });
    sockets.set(socket, terminal);
    socket.once('close', () => {
      resolve();
    });
    socket.on('error', (value) => {
      first ??= { value };
    });
    if (closing || options.signal.aborted || sockets.size > 16) {
      first ??= { value: new Error('COPY_ORIGIN_CAPACITY') };
      fence();
    }
  });
  const removals: Array<() => void> = [];
  const stopped = new Promise<never>((_, reject) => {
    const abort = () => reject(options.signal.reason);
    options.signal.addEventListener('abort', abort, { once: true });
    removals.push(() => options.signal.removeEventListener('abort', abort));
    if (options.signal.aborted) abort();
  });
  void stopped.catch(() => undefined);
  try {
    options.signal.addEventListener('abort', fence, { once: true });
    current();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    current();
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('COPY_ORIGIN_UNAVAILABLE');
    const origin = `http://127.0.0.1:${address.port}`;
    await withOriginalInstalledBrowserRound(
      { ...options, native, round: 0, retainRetirement },
      async (port) => {
        const requestId = randomUUID();
        const opened = BrowserProductionOpenReceiptSchema.parse(
          await port.request('/api/browser/runtime/open', {
            workspaceId: options.input.workspaceId,
            request: { requestId, mode: 'ephemeral' },
          })
        );
        if (opened.requestId !== requestId) throw new Error('COPY_ORIGINAL_OPEN_REQUIRED');
        await port.birth(opened.binding);
        for (const kind of ['ordinary', 'password'] as const) {
          current();
          const control = BrowserControlSchema.parse(
            await port.request('/api/browser/control', opened.binding)
          );
          if (control.status !== 'ready' || !control.controllerId)
            throw new Error('COPY_ORIGINAL_CONTROL_REQUIRED');
          const permissionId = randomUUID(),
            permission = BrowserLocalDestinationReceiptSchema.parse(
              await port.request('/api/browser/runtime/local-destination', {
                requestId: permissionId,
                binding: control.binding,
                endpoint: origin + '/',
                ttlMilliseconds: 300000,
              })
            );
          if (permission.requestId !== permissionId || permission.endpoint !== origin)
            throw new Error('COPY_ORIGINAL_DESTINATION_REQUIRED');
          const navigateId = randomUUID();
          const navigation = BrowserProductionNavigateReceiptSchema.parse(
            await port.request('/api/browser/runtime/navigate', {
              controllerId: control.controllerId,
              command: {
                kind: 'navigate',
                requestId: navigateId,
                binding: control.binding,
                url: origin + '/' + kind,
              },
            })
          );
          if (navigation.requestId !== navigateId)
            throw new Error('COPY_ORIGINAL_NAVIGATION_REQUIRED');
          await Promise.race([ready.get(kind)!.promise, stopped]);
          current();
          const active = BrowserControlSchema.parse(
            await port.request('/api/browser/control', navigation.binding)
          );
          if (active.status !== 'ready' || !active.controllerId)
            throw new Error('COPY_ORIGINAL_CONTROL_REQUIRED');
          const id = randomUUID();
          const result = BrowserCopySelectionReceiptSchema.parse(
            await port.request('/api/browser/copy-selection', {
              controllerId: active.controllerId,
              command: { requestId: id, binding: active.binding },
            })
          );
          if (
            result.requestId !== id ||
            (Object.keys(active.binding) as (keyof typeof active.binding)[]).some(
              (key) => result.binding[key] !== active.binding[key]
            )
          )
            throw new Error('COPY_ORIGINAL_BINDING_REQUIRED');
          if (
            kind === 'ordinary'
              ? result.outcome !== 'selected' || result.text !== 'ordinary'
              : result.outcome !== 'refused' || result.reason !== 'secret'
          )
            throw new Error('COPY_ORIGINAL_SELECTION_REQUIRED');
          await retain({
            kind: 'original-selection-copy',
            subject: kind,
            binding: active.binding,
            outcome: result.outcome,
            clipboard: 'UNTOUCHED',
          });
        }
        const receipt = BrowserCloseReceiptSchema.parse(
          await port.request('/api/browser/runtime/close', {
            browserId: opened.binding.browserId,
            browserGeneration: opened.binding.browserGeneration,
            stopKind: 'explicitStop',
          })
        );
        if (
          receipt.cleanup !== 'observed' ||
          receipt.browserId !== opened.binding.browserId ||
          receipt.browserGeneration !== opened.binding.browserGeneration
        )
          throw new Error('COPY_ORIGINAL_CLOSE_REQUIRED');
      }
    );
  } catch (value) {
    first ??= { value };
  } finally {
    try {
      await close();
    } catch (value) {
      first ??= { value };
    }
    for (const remove of removals)
      try {
        remove();
      } catch (value) {
        first ??= { value };
      }
  }
  if (first) throw first.value;
}
