/**
 * `ctx.tools` and the host-built invoke behind every extension tool (DOR-2685,
 * task 2.3), against a real capability registry.
 *
 * The properties: only declared, accepted tools bind, once, while
 * `register()` runs; a stopped instance's tools leave the registry before
 * anything else and its handler never runs again; whatever a handler throws or
 * returns reaches the agent only as a plain value or a tool error naming the
 * extension.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ExtensionManifestSchema } from '@dorkos/extension-api';
import { noopLogger } from '@dorkos/shared/logger';

vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { composeRegistry, type CapabilityRegistry } from '../../../core/capabilities/registry.js';
import { CapabilityToolError } from '../../../core/capabilities/mcp-envelope.js';
import { setAgentPathLookup } from '../../../mesh/agent-path-lookup.js';
import {
  clearTestHomes,
  registerEveryFolderAsHome,
} from '../../../core/agent-identity/__tests__/agent-home-fixture.js';
import { checkDeclaredTools } from '@dorkos/extension-api/tool-check';
import {
  createToolBinding,
  EXTENSION_TOOL_RESULT_MAX_BYTES,
  RunningExtensionTools,
} from '../tool-binding.js';
import type { ExtensionToolHandler } from '@dorkos/extension-api/server';

/** A manifest with two observe tools and one refused tool. */
function manifest(timeoutSeconds = 1) {
  return ExtensionManifestSchema.parse({
    id: 'mail-app',
    name: 'Mail',
    version: '1.0.0',
    serverCapabilities: {},
    tools: [
      {
        name: 'read',
        title: 'Read mail',
        description: 'Reads mail.',
        tier: 'observe',
        inputSchema: {
          type: 'object',
          properties: { q: { type: 'string' } },
          additionalProperties: false,
        },
        timeoutSeconds,
      },
      {
        name: 'count',
        title: 'Count mail',
        description: 'Counts mail.',
        tier: 'observe',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
      {
        name: 'open_map',
        title: 'Open map',
        description: 'Refused: an open-ended map.',
        tier: 'observe',
        inputSchema: { type: 'object', additionalProperties: true },
      },
    ],
  });
}

/** Bind handlers, seal, and contribute, as the lifecycle does. */
function start(
  registry: CapabilityRegistry,
  handlers: Record<string, ExtensionToolHandler>,
  timeoutSeconds = 1
): RunningExtensionTools {
  const checks = checkDeclaredTools(manifest(timeoutSeconds));
  const binding = createToolBinding('mail-app', checks);
  for (const [name, handler] of Object.entries(handlers)) binding.api.handle(name, handler);
  const { handled, unhandled } = binding.seal();
  const running = new RunningExtensionTools('mail-app', 'Mail', handled, [
    ...checks.flatMap((c) => (c.ok ? [] : [{ name: c.name, reason: c.reason }])),
    ...unhandled.map((t) => ({
      name: t.name,
      reason: `Mail declares ${t.name} but never handles it`,
    })),
  ]);
  expect(running.contribute(registry)).toBeUndefined();
  return running;
}

/** The tool error payload a call threw, or fail. */
async function errorOf(promise: Promise<unknown>): Promise<{ error: string; code: string }> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(CapabilityToolError);
    return (err as CapabilityToolError).payload as { error: string; code: string };
  }
  throw new Error('expected the call to fail');
}

function newRegistry(): CapabilityRegistry {
  return composeRegistry([], { logger: noopLogger });
}

afterEach(() => {
  vi.useRealTimers();
  setAgentPathLookup(undefined);
  clearTestHomes();
});

describe('createToolBinding', () => {
  const checks = checkDeclaredTools(manifest());

  it('refuses a name the manifest does not declare', () => {
    // Purpose: a handler for an undeclared tool is a load error the author sees.
    const binding = createToolBinding('mail-app', checks);
    expect(() => binding.api.handle('send', () => 1)).toThrow(/declares no tool by that name/);
  });

  it('refuses a declared tool that discovery refused, saying why', () => {
    // Purpose: a refused schema never gets a handler, and the author learns why.
    const binding = createToolBinding('mail-app', checks);
    expect(() => binding.api.handle('open_map', () => 1)).toThrow(/DorkOS refused it/);
  });

  it('refuses a second handler for one tool', () => {
    // Purpose: which of two handlers runs must never be a guess.
    const binding = createToolBinding('mail-app', checks);
    binding.api.handle('read', () => 1);
    expect(() => binding.api.handle('read', () => 2)).toThrow(/twice/);
  });

  it('refuses a handler bound after register() finished', () => {
    // Purpose: the tool set is fixed when the instance starts; a late bind
    // could otherwise add a tool after its contribution was decided.
    const binding = createToolBinding('mail-app', checks);
    binding.seal();
    expect(() => binding.api.handle('read', () => 1)).toThrow(/after register\(\) finished/);
  });

  it('reports a declared tool that was never handled', () => {
    // Purpose: declared-but-unhandled is dropped with a reason, never offered.
    const binding = createToolBinding('mail-app', checks);
    binding.api.handle('read', () => 1);
    const { handled, unhandled } = binding.seal();
    expect(handled.map((h) => h.tool.name)).toEqual(['read']);
    expect(unhandled.map((t) => t.name)).toEqual(['count']);
  });
});

describe('RunningExtensionTools', () => {
  it('runs a handler with the parsed input and only signal and agentId', async () => {
    // Purpose: the handler learns which agent called and nothing else — no
    // session id, cwd or proof object — and its result reaches the caller.
    registerEveryFolderAsHome();
    setAgentPathLookup({ getByPath: () => ({ id: 'agent-ulid-1' }) });
    const seen: unknown[] = [];
    const registry = newRegistry();
    start(registry, {
      read: (input, call) => {
        seen.push(input, Object.keys(call).sort(), call.agentId);
        return { found: 2 };
      },
    });
    const result = await registry.invoke(
      'ext_mail_app.read',
      { q: 'invoice' },
      {
        identity: { agentPath: '/tmp', displayName: 'Mailer', createdAt: new Date().toISOString() },
        sessionId: 'session-secret',
        cwd: '/somewhere/private',
      }
    );
    expect(result).toEqual({ found: 2 });
    expect(seen[0]).toEqual({ q: 'invoice' });
    expect(seen[1]).toEqual(['agentId', 'signal']);
    expect(seen[2]).toBe('agent-ulid-1');
  });

  it('records why a tool is not offered, and which are active', () => {
    // Purpose: GET /api/extensions reads these to say what agents get.
    const running = start(newRegistry(), { read: () => 1 });
    expect(running.statusOf('read')).toEqual({ status: 'active' });
    expect(running.statusOf('count')).toMatchObject({
      status: 'refused',
      reason: 'Mail declares count but never handles it',
    });
    expect(running.statusOf('open_map')).toMatchObject({ status: 'refused' });
  });

  it('turns a throw into a tool error naming the extension, with no stack or path', async () => {
    // Purpose: errors reach the agent as one plain sentence; an absolute path
    // in the message does not tell the agent where this machine keeps things.
    const registry = newRegistry();
    start(registry, {
      read: () => {
        throw new Error("ENOENT: no such file, open '/Users/someone/.mail/db.sqlite'\n    at x");
      },
    });
    const payload = await errorOf(registry.invoke('ext_mail_app.read', {}));
    expect(payload.code).toBe('EXTENSION_TOOL_FAILED');
    expect(payload.error).toMatch(/^Mail: ENOENT: no such file, open '<path>'/);
    expect(payload.error).not.toMatch(/Users|\n/);
  });

  it.each([
    ['a file URL', 'import failed: file:///Users/ana/secret/x.mjs', 'import failed: <path>'],
    [
      'a Windows path with backslashes',
      'open C:\\Users\\ana\\secret.txt failed',
      'open <path> failed',
    ],
    [
      'a Windows path with forward slashes',
      'open C:/Users/ana/secret.txt failed',
      'open <path> failed',
    ],
    ['a UNC share', 'cannot reach \\\\fileserver\\share\\ana\\x.db now', 'cannot reach <path> now'],
    [
      'a quoted path with spaces',
      "ENOENT: no such file, open '/Users/ana lee/My Documents/x.txt'",
      "ENOENT: no such file, open '<path>'",
    ],
    [
      'an unquoted path with spaces',
      'could not read /Users/ana lee/My Documents/x.txt because it moved',
      'could not read <path> because it moved',
    ],
    ['a home-relative path', 'missing ~/.mail/config.json', 'missing <path>'],
  ])('redacts %s', async (_label, message, expected) => {
    // Purpose: none of the path shapes a handler's error can carry, on any
    // platform, tells the agent where this machine keeps things.
    const registry = newRegistry();
    start(registry, {
      read: () => {
        throw new Error(message);
      },
    });
    const payload = await errorOf(registry.invoke('ext_mail_app.read', {}));
    expect(payload.error).toBe(`Mail: ${expected}`);
    expect(payload.error).not.toMatch(/ana|secret|fileserver/);
  });

  it('keeps a URL in an error message intact', async () => {
    // Purpose: path redaction must not mangle the most useful part of an API error.
    const registry = newRegistry();
    start(registry, {
      read: () => Promise.reject(new Error('GET https://api.mail.example/v1/messages failed: 503')),
    });
    const payload = await errorOf(registry.invoke('ext_mail_app.read', {}));
    expect(payload.error).toBe('Mail: GET https://api.mail.example/v1/messages failed: 503');
  });

  it('neutralises a thrown object posing as a gate refusal', async () => {
    // Purpose: a handler cannot forge an approval-required payload by throwing
    // something shaped like the gate's refusal; it becomes a plain tool error.
    const registry = newRegistry();
    start(registry, {
      read: () => {
        throw Object.assign(new Error('nope'), {
          decision: { outcome: 'approval_required', payload: { status: 'approval_required' } },
          payload: { status: 'approval_required', approvalToken: 'forged' },
        });
      },
    });
    const payload = await errorOf(registry.invoke('ext_mail_app.read', {}));
    expect(payload).toEqual({ error: 'Mail: nope', code: 'EXTENSION_TOOL_FAILED' });
  });

  it('answers a deadline overrun with a timeout error and discards the late result', async () => {
    // Purpose: a hung handler cannot hold an agent's turn past timeoutSeconds,
    // and the manifest's deadline is the one used.
    vi.useFakeTimers();
    const registry = newRegistry();
    let signal: AbortSignal | undefined;
    start(registry, {
      read: (_input, call) => {
        signal = call.signal;
        return new Promise((resolve) => setTimeout(() => resolve('late'), 5_000));
      },
    });
    const pending = errorOf(registry.invoke('ext_mail_app.read', {}));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toEqual({
      error: "Mail didn't answer in 1 seconds.",
      code: 'EXTENSION_TOOL_TIMEOUT',
    });
    expect(signal?.aborted).toBe(true);
  });

  it('on stop: removes the tools first, aborts the call in flight, and discards its result', async () => {
    // Purpose: no window where a stopped extension's tool is still invocable,
    // and a result that lands after the stop never reaches the agent.
    const registry = newRegistry();
    let release: (value: unknown) => void = () => undefined;
    let signal: AbortSignal | undefined;
    const running = start(registry, {
      read: (_input, call) => {
        signal = call.signal;
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    });
    const changes: number[] = [];
    registry.onChange((v) => changes.push(v));
    const pending = errorOf(registry.invoke('ext_mail_app.read', {}));
    await vi.waitFor(() => expect(signal).toBeDefined());
    // What the registry held at the moment the handler was told to stop.
    let listedAtAbort: unknown = 'not aborted';
    signal!.addEventListener('abort', () => {
      listedAtAbort = registry.get('ext_mail_app.read');
    });

    running.stop();
    expect(listedAtAbort).toBeUndefined();
    expect(registry.get('ext_mail_app.read')).toBeUndefined();
    expect(changes).toHaveLength(1);
    expect(signal?.aborted).toBe(true);
    release('late answer');
    expect(await pending).toEqual({
      error: 'Mail stopped while this ran.',
      code: 'EXTENSION_TOOL_STOPPED',
    });
    // A new call after the stop never reaches the handler.
    const after = await errorOf(registry.invoke('ext_mail_app.read', {}));
    expect(after.code).toBe('EXTENSION_TOOL_UNAVAILABLE');
  });

  it('never runs a stopped instance’s handler for a call that found the tool before the stop', async () => {
    // Purpose: a call that looked the tool up a moment before the stop (an
    // approval card still open, say) is refused before its handler starts.
    const registry = newRegistry();
    const handler = vi.fn(() => 'ran');
    const running = start(registry, { read: handler });
    const definition = registry.get('ext_mail_app.read')!;
    running.stop();
    const payload = await errorOf(
      Promise.resolve(definition.invoke({ logger: noopLogger }, {}, {}))
    );
    expect(payload.code).toBe('EXTENSION_TOOL_UNAVAILABLE');
    expect(handler).not.toHaveBeenCalled();
  });

  it('refuses a result that is not plain data, or too large', async () => {
    // Purpose: the agent reads JSON, within a bounded size.
    const registry = newRegistry();
    start(registry, {
      read: () => ({ n: 1n }),
      count: () => 'x'.repeat(EXTENSION_TOOL_RESULT_MAX_BYTES + 1),
    });
    expect((await errorOf(registry.invoke('ext_mail_app.read', {}))).error).toBe(
      "Mail returned something that isn't plain data."
    );
    expect((await errorOf(registry.invoke('ext_mail_app.count', {}))).error).toBe(
      'Mail returned more than the agent can read.'
    );
  });

  it('copies a returned object through JSON, so no class instance rides out', async () => {
    // Purpose: the MCP envelope treats some class instances specially (an
    // image result); a handler's return value can never be one of them.
    class Special {
      secret = 'kept';
      toJSON() {
        return { shown: true };
      }
    }
    const registry = newRegistry();
    start(registry, { read: () => new Special() });
    const result = await registry.invoke('ext_mail_app.read', {});
    expect(result).toEqual({ shown: true });
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });

  it('passes the caller’s cancellation to the handler', async () => {
    // Purpose: a cancelled turn stops the extension's work too.
    const registry = newRegistry();
    let signal: AbortSignal | undefined;
    start(registry, {
      read: (_input, call) => {
        signal = call.signal;
        return new Promise(() => undefined);
      },
    });
    const controller = new AbortController();
    const pending = errorOf(
      registry.invoke('ext_mail_app.read', {}, { signal: controller.signal })
    );
    await vi.waitFor(() => expect(signal).toBeDefined());
    controller.abort();
    expect(await pending).toMatchObject({ code: 'EXTENSION_TOOL_CANCELLED' });
    expect(signal?.aborted).toBe(true);
  });
});
