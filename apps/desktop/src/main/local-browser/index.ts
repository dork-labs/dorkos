/* eslint-disable no-restricted-syntax -- Private shell-to-child credentials are transient handoff state, not app configuration. */
import { BrowserWindow, WebContentsView, ipcMain, session } from 'electron';
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type { ConnectOverCDPTransport } from 'playwright-core';
import { isCockpitSender as isAppSender, isWebLink } from '../window-manager';
import { pageTransport } from './page-transport';

export const LOCAL_BROWSER_BOUNDS_CHANNEL = 'local-browser:set-bounds';
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
  parent?: BrowserWindow;
  onParentClosed?: () => void;
  transport?: ConnectOverCDPTransport;
  socket?: WebSocket;
  attachTimer?: ReturnType<typeof setTimeout>;
  popups?: Set<BrowserWindow>;
}

/** A private authenticated bridge from the child server to page-only guest targets. */
export async function startLocalBrowserBridge(
  getRendererUrl: () => string | undefined,
  getWindow: () => BrowserWindow | null
): Promise<{ close(): Promise<void> }> {
  const token = randomBytes(32).toString('hex');
  const guests = new Map<string, Guest>();
  const guestSession = session.fromPartition('persist:dorkos-local-browser');
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
      if (request.method !== 'POST' || !['/open', '/close'].includes(request.url ?? '')) {
        response.writeHead(404).end();
        return;
      }
      let body = '';
      for await (const chunk of request) {
        body += chunk.toString();
        if (body.length > 1024) {
          response.writeHead(413).end();
          return;
        }
      }
      const { connectionId } = JSON.parse(body);
      if (typeof connectionId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(connectionId)) {
        response.writeHead(400).end();
        return;
      }
      if (request.url === '/close') {
        closeGuest(connectionId);
        response.writeHead(200).end('{}');
        return;
      }
      if (guests.has(connectionId)) {
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
      const guest: Guest = { view };
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
        if (!isWebLink(url) && url !== 'about:blank' && url !== '') return { action: 'deny' };
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
        popup.webContents.on('will-navigate', (event) => {
          if (!isWebLink(event.url)) event.preventDefault();
        });
        popup.webContents.on('did-create-window', trackPopup);
      };
      // Preserve window.opener and postMessage for real sign-in windows. They never get our preload.
      view.webContents.setWindowOpenHandler(allowPopup);
      view.webContents.on('did-create-window', trackPopup);
      view.webContents.on('will-navigate', (event) => {
        if (!isWebLink(event.url)) event.preventDefault();
      });
      view.webContents.once('destroyed', () => closeGuest(connectionId));
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
    if (!authorized(request.headers.authorization) || !guest || guest.socket) {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => {
      clearTimeout(guest.attachTimer);
      guest.socket = ws;
      try {
        guest.transport = pageTransport(guest.view.webContents);
      } catch {
        ws.close(1011);
        guest.socket = undefined;
        return;
      }
      guest.transport.onmessage = (message) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
      };
      guest.transport.onclose = () => ws.close();
      ws.on('message', (bytes) => {
        try {
          const message = JSON.parse(bytes.toString());
          if (!Number.isInteger(message.id) || typeof message.method !== 'string')
            throw new Error('Unsupported command');
          guest.transport?.send(message);
        } catch {
          ws.close(1008);
        }
      });
      ws.once('close', () => {
        guest.transport?.close();
        guest.transport = undefined;
        guest.socket = undefined;
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
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
  } catch (error) {
    ipcMain.removeHandler(LOCAL_BROWSER_BOUNDS_CHANNEL);
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
      for (const id of guests.keys()) closeGuest(id);
      sockets.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      delete process.env.DORKOS_LOCAL_BROWSER_BRIDGE;
      delete process.env.DORKOS_LOCAL_BROWSER_BRIDGE_TOKEN;
    },
  };
}
