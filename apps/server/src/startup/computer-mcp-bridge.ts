/** Fixed-path guest forwarding preserves the existing turn-bound runtime authority. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { ConnectorRuntimeTools } from '../services/runtimes/connector-tools.js';
import {
  CONNECTOR_RUNTIME_CWD_HEADER,
  CONNECTOR_RUNTIME_KIND_HEADER,
} from '../services/runtimes/connector-tools.js';

export interface ComputerMcpBridge {
  port: number;
  configure(tools: ConnectorRuntimeTools): void;
  mapUrl(url: string): string | undefined;
  close(): Promise<void>;
}

/** Open a private bridge; neither callers nor guest JSON may select its destinations. */
export async function startComputerMcpBridge(options: {
  anchor: string;
  acceptingWork(): boolean;
  currentGeneration(): number | undefined;
  port?: number;
}): Promise<ComputerMcpBridge> {
  const targets = new Map<string, string>();
  const active = new Set<AbortController>();
  let closed = false;
  const server = createServer((req, res) => {
    void forward(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
  });
  async function forward(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const target = targets.get(req.url ?? '');
    const peer = req.socket.remoteAddress;
    if (
      closed ||
      !options.acceptingWork() ||
      !target ||
      !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer ?? '') ||
      !['GET', 'POST', 'DELETE'].includes(req.method ?? '') ||
      req.headers[CONNECTOR_RUNTIME_KIND_HEADER.toLowerCase()] !== 'computer-local' ||
      req.headers['x-dorkos-computer-generation'] !== String(options.currentGeneration()) ||
      typeof req.headers.authorization !== 'string' ||
      !req.headers.authorization.startsWith('Bearer ')
    ) {
      res.writeHead(403);
      res.end();
      return;
    }
    const cwd = req.headers[CONNECTOR_RUNTIME_CWD_HEADER.toLowerCase()];
    if (typeof cwd !== 'string' || decodeURIComponent(cwd) !== options.anchor) {
      res.writeHead(403);
      res.end();
      return;
    }
    const controller = new AbortController();
    active.add(controller);
    const fence = setInterval(() => {
      if (
        closed ||
        !options.acceptingWork() ||
        req.headers['x-dorkos-computer-generation'] !== String(options.currentGeneration())
      )
        controller.abort(new Error('COMPUTER_BRIDGE_RETIRED'));
    }, 250);
    fence.unref();
    const disconnected = () => controller.abort();
    res.on('close', disconnected);
    try {
      let bytes = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > 1024 * 1024) {
          res.writeHead(413);
          res.end();
          return;
        }
        chunks.push(buffer);
      }
      if (
        !options.acceptingWork() ||
        req.headers['x-dorkos-computer-generation'] !== String(options.currentGeneration()) ||
        controller.signal.aborted
      ) {
        res.writeHead(403);
        res.end();
        return;
      }
      const headers = new Headers();
      for (const key of [
        'authorization',
        CONNECTOR_RUNTIME_KIND_HEADER.toLowerCase(),
        CONNECTOR_RUNTIME_CWD_HEADER.toLowerCase(),
        'content-type',
        'accept',
        'mcp-session-id',
        'mcp-protocol-version',
      ]) {
        const value = req.headers[key];
        if (typeof value === 'string') headers.set(key, value);
      }
      const response = await fetch(target, {
        method: req.method,
        headers,
        body: req.method === 'POST' ? Buffer.concat(chunks) : undefined,
        signal: controller.signal,
        redirect: 'error',
      });
      if (
        !options.acceptingWork() ||
        req.headers['x-dorkos-computer-generation'] !== String(options.currentGeneration())
      )
        throw new Error('COMPUTER_BRIDGE_RETIRED');
      for (const key of ['content-type', 'mcp-session-id', 'cache-control']) {
        const value = response.headers.get(key);
        if (value) res.setHeader(key, value);
      }
      res.writeHead(response.status);
      if (!response.body) {
        res.end();
        return;
      }
      const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
      const cancelBody = () => {
        body.destroy();
        res.destroy();
      };
      controller.signal.addEventListener('abort', cancelBody, { once: true });
      if (controller.signal.aborted) cancelBody();
      await new Promise<void>((resolve, reject) => {
        body.on('error', reject);
        res.once('finish', resolve);
        res.once('close', resolve);
        body.pipe(res);
      });
    } finally {
      clearInterval(fence);
      active.delete(controller);
      res.off('close', disconnected);
    }
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('COMPUTER_BRIDGE_LISTEN_FAILED');
  const port = address.port;
  return {
    port,
    configure(tools) {
      targets.clear();
      for (const [path, value] of [
        ['/mcp', tools.listenerUrl],
        ['/agent-mcp', tools.agentToolsUrl],
      ] as const) {
        if (!value) continue;
        const url = new URL(value);
        if (
          url.protocol !== 'http:' ||
          !['127.0.0.1', '[::1]'].includes(url.hostname) ||
          url.username ||
          url.password ||
          url.pathname !== path ||
          url.search ||
          url.hash
        ) {
          throw new Error('COMPUTER_BRIDGE_TARGET_REFUSED');
        }
        targets.set(path, value);
      }
    },
    mapUrl(url) {
      for (const [path, target] of targets) {
        if (url === target && !closed) return `http://host.lima.internal:${port}${path}`;
      }
      return undefined;
    },
    async close() {
      closed = true;
      for (const controller of active) controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    },
  };
}
