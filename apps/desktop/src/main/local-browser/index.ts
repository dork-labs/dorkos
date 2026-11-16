/* eslint-disable no-restricted-syntax -- Private shell-to-child credentials are transient handoff state, not app configuration. */
import { BrowserWindow, WebContentsView, ipcMain, session } from 'electron';
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type { ConnectOverCDPTransport } from 'playwright-core';
import { isCockpitSender as isAppSender } from '../window-manager';
import { forgetGuestSignIns } from './forget-sign-ins';
import { chromeIdentity } from './browser-identity';
import { pageTransport } from './page-transport';
import { isGuestPageAction, watchGuestPage } from './page-events';
import { createAgentInputGate, forwardGuestShortcuts } from './page-keys';
import { capturePageStill } from './page-still';
import {
  guardGuestNavigation,
  guestNavigationAllowed,
  readGuestHistory,
  stepGuestHistory,
} from './page-history';

export const LOCAL_BROWSER_BOUNDS_CHANNEL = 'local-browser:set-bounds';
/** The shell tells the window showing a guest that the person pressed a browser key in it (DOR-4432). */
export const LOCAL_BROWSER_SHORTCUT_CHANNEL = 'local-browser:shortcut';
/** The app asks about or acts on one guest page (DOR-4430, DOR-4431). */
const LOCAL_BROWSER_PAGE_CHANNEL = 'local-browser:page';
/** The shell tells the window showing a guest that its page started, stopped or failed a load. */
const LOCAL_BROWSER_PAGE_CHANGED_CHANNEL = 'local-browser:page-changed';
/** A still of the page the asking window shows now (DOR-4438); see `page-still.ts`. */
export const LOCAL_BROWSER_STILL_CHANNEL = 'local-browser:capture-still';
export interface BrowserBounds {
  connectionId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
}
interface Guest {
  view: WebContentsView;
  detached?: boolean;
  parent?: BrowserWindow;
  onParentClosed?: () => void;
  transport?: ConnectOverCDPTransport;
  socket?: WebSocket;
  attachTimer?: ReturnType<typeof setTimeout>;
  popups?: Set<BrowserWindow>;
  page?: ReturnType<typeof watchGuestPage>;
  inputGate: ReturnType<typeof createAgentInputGate>;
  keys?: () => void;
  /** Loads the navigation guard refused, so a history step can say it was refused. */
  refusals: number;
  /** The server's list of its own addresses, refreshed on every history call. */
  refused: string[];
}

/** The server's list of its own addresses, as one history call sends it, or null when malformed. */
function refusedList(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 256) return null;
  return value.every((entry) => typeof entry === 'string' && entry.length <= 512) ? value : null;
}

/** A private authenticated bridge from the child server to page-only guest targets. */
export async function startLocalBrowserBridge(
  getRendererUrl: () => string | undefined,
  getWindow: () => BrowserWindow | null
): Promise<{ close(): Promise<void> }> {
  const token = randomBytes(32).toString('hex');
  let forgetting = false;
  const guests = new Map<string, Guest>();
  const guestSession = session.fromPartition('persist:dorkos-local-browser');
  const identity = chromeIdentity(
    process.versions.chrome,
    process.platform,
    process.arch,
    process.getSystemVersion()
  );
  guestSession.setUserAgent(identity.userAgent);
  guestSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  guestSession.setPermissionCheckHandler(() => false);
  const authorized = (value: string | string[] | undefined): boolean => {
    if (typeof value !== 'string') return false;
    const actual = Buffer.from(value);
    const expected = Buffer.from(`Bearer ${token}`);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
  const closeGuest = (id: string): void => {
    const guest = guests.get(id);
    if (!guest) return;
    guests.delete(id);
    if (guest.parent && guest.onParentClosed)
      guest.parent.removeListener('closed', guest.onParentClosed);
    clearTimeout(guest.attachTimer);
    guest.page?.dispose();
    guest.keys?.();
    for (const popup of guest.popups ?? []) if (!popup.isDestroyed()) popup.destroy();
    guest.socket?.terminate();
    guest.transport?.close();
    if (guest.parent && !guest.parent.isDestroyed())
      guest.parent.contentView.removeChildView(guest.view);
    if (!guest.view.webContents.isDestroyed()) guest.view.webContents.close();
  };
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const server = createServer((request, response) => {
    void (async () => {
      if (!authorized(request.headers.authorization)) {
        response.writeHead(403).end();
        return;
      }
      if (
        request.method !== 'POST' ||
        ![
          '/open',
          '/close',
          '/detach',
          '/reattach',
          '/forget-sign-ins',
          '/history',
          '/history/go',
        ].includes(request.url ?? '')
      ) {
        response.writeHead(404).end();
        return;
      }
      let body = '';
      for await (const chunk of request) {
        body += chunk.toString();
        // History calls carry the server's address list; every other call stays tiny.
        if (body.length > (request.url?.startsWith('/history') ? 65_536 : 1024)) {
          response.writeHead(413).end();
          return;
        }
      }
      const { connectionId, index, urlHash, refused } = JSON.parse(body);
      if (typeof connectionId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(connectionId)) {
        response.writeHead(400).end();
        return;
      }
      if (request.url === '/history' || request.url === '/history/go') {
        // Back and Forward (DOR-4449): this process re-checks the entry and refuses
        // refused loads on the way itself; the server only names which entry.
        const guest = guests.get(connectionId);
        if (!guest || guest.detached || guest.view.webContents.isDestroyed()) {
          response.writeHead(404).end();
          return;
        }
        const list = refusedList(refused);
        if (!list) {
          response.writeHead(400).end();
          return;
        }
        guest.refused = list;
        const contents = guest.view.webContents;
        if (request.url === '/history') {
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify(readGuestHistory(contents)));
          return;
        }
        if (
          typeof index !== 'number' ||
          typeof urlHash !== 'string' ||
          !/^[a-f0-9]{64}$/.test(urlHash)
        ) {
          response.writeHead(400).end();
          return;
        }
        const outcome = await stepGuestHistory(
          contents,
          index,
          urlHash,
          { rendererUrl: getRendererUrl(), refused: guest.refused },
          () => guest.refusals
        );
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ outcome }));
        return;
      }
      if (request.url === '/close') {
        closeGuest(connectionId);
        response.writeHead(200).end('{}');
        return;
      }
      if (request.url === '/detach' || request.url === '/reattach') {
        const guest = guests.get(connectionId);
        if (!guest) {
          response.writeHead(404).end();
          return;
        }
        if (request.url === '/detach') {
          // Close the debugger synchronously before acknowledging the handoff. A
          // saved endpoint cannot attach again until the server answers Hand back.
          guest.detached = true;
          clearTimeout(guest.attachTimer);
          guest.transport?.close();
          guest.transport = undefined;
          guest.socket?.terminate();
          guest.socket = undefined;
        } else {
          guest.detached = false;
        }
        response.writeHead(200).end('{}');
        return;
      }
      if (request.url === '/forget-sign-ins') {
        if (forgetting) {
          response.writeHead(409).end();
          return;
        }
        forgetting = true;
        try {
          await forgetGuestSignIns(guestSession, async () => {
            const closed = [...guests].map(([id, guest]) => {
              const contents = guest.view.webContents;
              const done = contents.isDestroyed()
                ? Promise.resolve()
                : new Promise<void>((resolve) => contents.once('destroyed', () => resolve()));
              closeGuest(id);
              return done;
            });
            await Promise.all(closed);
          });
          response.writeHead(200).end('{}');
        } finally {
          forgetting = false;
        }
        return;
      }
      if (forgetting || guests.has(connectionId)) {
        response.writeHead(409).end();
        return;
      }
      const view = new WebContentsView({
        webPreferences: {
          session: guestSession,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false,
        },
      });
      const guest: Guest = { view, inputGate: createAgentInputGate(), refusals: 0, refused: [] };
      const rules = () => ({ rendererUrl: getRendererUrl(), refused: guest.refused });
      const parent = getWindow();
      if (!parent || parent.isDestroyed()) {
        view.webContents.close();
        response.writeHead(409).end();
        return;
      }
      guest.parent = parent;
      guest.onParentClosed = () => closeGuest(connectionId);
      parent.once('closed', guest.onParentClosed);
      parent.contentView.addChildView(view, 0);
      const initialArea = parent.getContentBounds();
      // Keep a useful viewport while the native surface is hidden.
      view.setBounds({
        x: 0,
        y: 0,
        width: Math.ceil(initialArea.width / 2),
        height: initialArea.height,
      });
      view.setVisible(false);
      guest.attachTimer = setTimeout(() => closeGuest(connectionId), 30_000);
      guests.set(connectionId, guest);
      guest.popups = new Set();
      const allowPopup = ({ url }: { url: string }): Electron.WindowOpenHandlerResponse => {
        if (!guestNavigationAllowed(url, rules()) && url !== 'about:blank' && url !== '')
          return { action: 'deny' };
        const popupParent = guest.parent;
        if (!popupParent || popupParent.isDestroyed()) return { action: 'deny' };
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            parent: popupParent,
            autoHideMenuBar: true,
            webPreferences: {
              session: guestSession,
              sandbox: true,
              contextIsolation: true,
              nodeIntegration: false,
            },
          },
        };
      };
      const trackPopup = (popup: BrowserWindow): void => {
        const popupParent = guest.parent;
        if (guests.get(connectionId) !== guest || !popupParent || popupParent.isDestroyed()) {
          popup.destroy();
          return;
        }
        // The native host can move between the open request and window creation.
        popup.setParentWindow(popupParent);
        guest.popups!.add(popup);
        // Popups preserve sign-in handshakes but never enter the agent's page-only transport.
        const popupTitle = 'Extra browser window • You only';
        popup.setTitle(popupTitle);
        popup.webContents.on('page-title-updated', (event) => {
          event.preventDefault();
          popup.setTitle(popupTitle);
        });
        popup.once('closed', () => guest.popups!.delete(popup));
        popup.webContents.setWindowOpenHandler(allowPopup);
        guardGuestNavigation(popup.webContents, rules);
        popup.webContents.on('did-create-window', trackPopup);
      };
      // Preserve window.opener and postMessage for real sign-in windows. They never get our preload.
      view.webContents.setWindowOpenHandler(allowPopup);
      view.webContents.on('did-create-window', trackPopup);
      // Every navigation and every redirect, history steps included, runs the address rules.
      guardGuestNavigation(view.webContents, rules, () => {
        guest.refusals += 1;
      });
      view.webContents.once('destroyed', () => closeGuest(connectionId));
      // Loads and failures go only to the window showing the page, which follows a move.
      guest.page = watchGuestPage(connectionId, view.webContents, (page) => {
        const shown = guest.parent;
        if (shown && !shown.isDestroyed())
          shown.webContents.send(LOCAL_BROWSER_PAGE_CHANGED_CHANNEL, page);
      });
      guest.keys = forwardGuestShortcuts(view.webContents, {
        platform: process.platform,
        gate: guest.inputGate,
        personFocused: () =>
          !!guest.parent && !guest.parent.isDestroyed() && guest.parent.isFocused(),
        // The app copies the address it shows, the same as ⌘⇧C in the panel.
        send: (shortcut) => {
          const shown = guest.parent;
          if (!shown || shown.isDestroyed()) return;
          if (shortcut === 'focus-address') shown.webContents.focus();
          shown.webContents.send(LOCAL_BROWSER_SHORTCUT_CHANNEL, { connectionId, shortcut });
        },
      });
      try {
        await view.webContents.loadURL('about:blank');
      } catch (error) {
        closeGuest(connectionId);
        throw error;
      }
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Browser bridge is unavailable');
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({
          connectionId,
          endpoint: `ws://127.0.0.1:${address.port}/page/${connectionId}`,
          headers: { Authorization: `Bearer ${token}` },
        })
      );
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  server.on('upgrade', (request, socket, head) => {
    const id = /^\/page\/([a-zA-Z0-9-]{1,64})$/.exec(request.url ?? '')?.[1];
    const guest = id ? guests.get(id) : undefined;
    if (!authorized(request.headers.authorization) || !guest || guest.detached || guest.socket) {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => {
      clearTimeout(guest.attachTimer);
      guest.socket = ws;
      try {
        guest.transport = pageTransport(guest.view.webContents, identity, guest.inputGate);
      } catch {
        ws.close(1011);
        guest.socket = undefined;
        return;
      }
      const transport = guest.transport;
      transport.onmessage = (message) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
      };
      transport.onclose = () => ws.close();
      ws.on('message', (bytes) => {
        try {
          const message = JSON.parse(bytes.toString());
          if (!Number.isInteger(message.id) || typeof message.method !== 'string')
            throw new Error('Unsupported command');
          transport.send(message);
        } catch {
          ws.close(1008);
        }
      });
      ws.once('close', () => {
        transport.close();
        if (guest.socket === ws) {
          guest.transport = undefined;
          guest.socket = undefined;
        }
      });
    });
  });
  ipcMain.handle(LOCAL_BROWSER_BOUNDS_CHANNEL, (event, bounds: BrowserBounds) => {
    if (!isAppSender(event, getRendererUrl) || event.senderFrame !== event.sender.mainFrame) return;
    const guest = guests.get(bounds?.connectionId);
    const parent = BrowserWindow.fromWebContents(event.sender);
    if (!guest || !parent || guest.view.webContents.isDestroyed()) return;
    if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) return;
    if (bounds.visible !== true) {
      // Closing a view hides it; its live page keeps a usable viewport for automation.
      // A stale renderer's cleanup must not hide a page another window now presents.
      if (guest.parent === parent) {
        guest.view.setVisible(false);
      }
      return;
    }
    if (guest.parent && guest.parent !== parent && !guest.parent.isDestroyed())
      guest.parent.contentView.removeChildView(guest.view);
    if (guest.parent !== parent) {
      if (guest.parent && guest.onParentClosed)
        guest.parent.removeListener('closed', guest.onParentClosed);
      parent.contentView.addChildView(guest.view);
      guest.parent = parent;
      // Move native ownership with the same guest; window.opener remains unchanged.
      for (const popup of guest.popups ?? []) {
        if (!popup.isDestroyed()) popup.setParentWindow(parent);
      }
      guest.onParentClosed = () => closeGuest(bounds.connectionId);
      parent.once('closed', guest.onParentClosed);
    }
    parent.contentView.addChildView(guest.view);
    const size = parent.getContentBounds();
    // Renderer rectangles use CSS pixels; native view bounds use window points.
    const zoom = parent.webContents.getZoomFactor();
    const x = Math.max(0, Math.min(size.width, Math.round(bounds.x * zoom)));
    const y = Math.max(0, Math.min(size.height, Math.round(bounds.y * zoom)));
    guest.view.setBounds({
      x,
      y,
      width: Math.max(0, Math.min(size.width - x, Math.round(bounds.width * zoom))),
      height: Math.max(0, Math.min(size.height - y, Math.round(bounds.height * zoom))),
    });
    guest.view.setVisible(bounds.visible === true);
  });
  ipcMain.handle(
    LOCAL_BROWSER_PAGE_CHANNEL,
    (event, input: { connectionId?: unknown; action?: unknown }) => {
      if (!isAppSender(event, getRendererUrl) || event.senderFrame !== event.sender.mainFrame)
        return null;
      const guest =
        typeof input?.connectionId === 'string' ? guests.get(input.connectionId) : undefined;
      if (!guest?.page || guest.view.webContents.isDestroyed() || !isGuestPageAction(input.action))
        return null;
      // Only the window showing the page may act on it.
      if (input.action !== 'read' && BrowserWindow.fromWebContents(event.sender) !== guest.parent)
        return null;
      guest.page.run(input.action);
      return guest.page.read();
    }
  );
  ipcMain.handle(LOCAL_BROWSER_STILL_CHANNEL, (event, connectionId: unknown) => {
    if (!isAppSender(event, getRendererUrl) || event.senderFrame !== event.sender.mainFrame)
      return null;
    const guest = typeof connectionId === 'string' ? guests.get(connectionId) : undefined;
    if (!guest) return null;
    return capturePageStill(guest.view, guest.parent, BrowserWindow.fromWebContents(event.sender));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
  } catch (error) {
    ipcMain.removeHandler(LOCAL_BROWSER_BOUNDS_CHANNEL);
    ipcMain.removeHandler(LOCAL_BROWSER_PAGE_CHANNEL);
    ipcMain.removeHandler(LOCAL_BROWSER_STILL_CHANNEL);
    sockets.close();
    server.close();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Browser bridge is unavailable');
  process.env.DORKOS_LOCAL_BROWSER_BRIDGE = `http://127.0.0.1:${address.port}`;
  process.env.DORKOS_LOCAL_BROWSER_BRIDGE_TOKEN = token;
  return {
    async close() {
      ipcMain.removeHandler(LOCAL_BROWSER_BOUNDS_CHANNEL);
      ipcMain.removeHandler(LOCAL_BROWSER_PAGE_CHANNEL);
      ipcMain.removeHandler(LOCAL_BROWSER_STILL_CHANNEL);
      for (const id of guests.keys()) closeGuest(id);
      sockets.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      delete process.env.DORKOS_LOCAL_BROWSER_BRIDGE;
      delete process.env.DORKOS_LOCAL_BROWSER_BRIDGE_TOKEN;
    },
  };
}
