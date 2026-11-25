/**
 * A raw JSON-RPC peer for the real vendored Codex binary, and the streamed
 * answers a loopback fake provider sends it. The production client refuses a
 * load without `permissions`; these suites load from the config layer alone.
 */
import http from 'node:http';
import readline from 'node:readline';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { APP_SERVER_ARGS } from '../../process-pool.js';

const children: ChildProcessWithoutNullStreams[] = [];

function stream(events: Array<Record<string, unknown>>): string {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

const USAGE = {
  input_tokens: 10,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 2,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: 12,
};

/** One streamed answer that runs `cmd` through `exec_command`. */
export function execCall(cmd: string): string {
  const call = {
    type: 'function_call',
    id: 'fc_1',
    call_id: 'call_default_permissions',
    name: 'exec_command',
    arguments: JSON.stringify({ cmd, login: false }),
  };
  return stream([
    { type: 'response.created', response: { id: 'resp_call' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...call, arguments: '' } },
    { type: 'response.output_item.done', output_index: 0, item: call },
    { type: 'response.completed', response: { id: 'resp_call', usage: USAGE } },
  ]);
}

/** One streamed plain-text answer. */
export function text(value: string): string {
  const item = {
    type: 'message',
    id: 'msg_1',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: value, annotations: [] }],
  };
  return stream([
    { type: 'response.created', response: { id: 'resp_1' } },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'resp_1', usage: USAGE } },
  ]);
}

/** Everything the sandboxed command printed, from the follow-up provider request. */
export function commandOutput(body: string): string {
  const request = JSON.parse(body) as { input?: { type?: string; output?: unknown }[] };
  return (request.input ?? [])
    .filter((item) => item.type === 'function_call_output' && typeof item.output === 'string')
    .map((item) => item.output as string)
    .join('\n');
}

/** A throwaway `CODEX_HOME`'s settings: file stores, no plugins, the fake provider at `base`. */
export function fakeProviderConfig(base: string): string {
  return (
    [
      'model_provider = "fake"',
      'cli_auth_credentials_store = "file"',
      'mcp_oauth_credentials_store = "file"',
      'features.plugins = false',
      '[model_providers.fake]',
      'name = "fake"',
      `base_url = "${base}/v1"`,
      'wire_api = "responses"',
      'requires_openai_auth = false',
      'request_max_retries = 0',
      'stream_max_retries = 0',
    ].join('\n') + '\n'
  );
}

/** A loopback Responses provider answering from `scripted` in order, then plain text. */
export async function fakeProvider(
  scripted: Array<(res: http.ServerResponse, body: string) => void>,
  other: (req: http.IncomingMessage, res: http.ServerResponse) => void = (_, res) =>
    res.writeHead(404).end()
): Promise<{ base: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (!req.url?.startsWith('/v1/responses')) return other(req, res);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const next = scripted.shift();
      if (next) next(res, body);
      else res.end(text('done'));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Stop every app-server this fixture spawned. */
export function killRawAppServers(): void {
  for (const child of children.splice(0)) child.kill('SIGKILL');
}

/** Spawn `binary` as an app-server and speak JSON-RPC to it; server requests are declined. */
export function rawAppServer(binary: string, cwd: string, env: Record<string, string>) {
  const child = spawn(binary, [...APP_SERVER_ARGS], { cwd, env, stdio: 'pipe' });
  children.push(child);
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  const waiters: Array<() => void> = [];
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line) as {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
      result?: unknown;
      error?: { message: string };
    };
    if (message.id !== undefined && message.method !== undefined) {
      // A server request (an approval): decline; approval policy is `never`.
      child.stdin.write(`${JSON.stringify({ id: message.id, result: { decision: 'decline' } })}\n`);
      return;
    }
    if (message.id !== undefined) {
      const waiting = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiting?.reject(new Error(message.error.message));
      else waiting?.resolve(message.result);
      return;
    }
    if (message.method)
      notifications.push({ method: message.method, params: message.params ?? {} });
    for (const wake of waiters.splice(0)) wake();
  });
  const request = <T>(method: string, params: unknown): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  const notify = (method: string) => child.stdin.write(`${JSON.stringify({ method })}\n`);
  const until = async (method: string, deadlineMs = 60_000) => {
    const deadline = Date.now() + deadlineMs;
    for (;;) {
      const found = notifications.find((n) => n.method === method);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`no ${method}; stderr: ${stderr.slice(-2000)}`);
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 500);
      });
    }
  };
  return { request, notify, until, stderr: () => stderr };
}
