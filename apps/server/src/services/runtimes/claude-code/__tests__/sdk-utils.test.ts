import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolveClaudeCliPath, createIdlePrompt, createHeldUserPrompt } from '../sdk/sdk-utils.js';

// Mutable holder so each test can steer the three resolution primitives.
// `exists` accepts either a flat boolean (every path exists / none do) or a
// per-path predicate — the env-override tests need to say "the override path
// is missing but the bundled one exists", which a single boolean can't express.
const h = vi.hoisted(() => ({
  resolve: ((_s: string): string => {
    throw new Error('not found');
  }) as (s: string) => string,
  exists: true as boolean | ((path: string) => boolean),
  which: null as string | null,
}));

vi.mock('node:module', () => ({
  createRequire: () => ({ resolve: (s: string) => h.resolve(s) }),
}));

vi.mock('node:fs', () => ({
  existsSync: (path: string) => (typeof h.exists === 'function' ? h.exists(path) : h.exists),
}));

/** Env var the packaged desktop app sets to an explicit `claude` binary path. */
const CLI_PATH_ENV = 'DORKOS_CLAUDE_CLI_PATH';

vi.mock('node:child_process', () => ({
  execFileSync: () => {
    if (h.which === null) throw new Error('not on PATH');
    return h.which;
  },
}));

describe('resolveClaudeCliPath — Hybrid native-binary resolution', () => {
  // Capture and clear the override env var so no test's setting can leak into
  // the next (or into the pre-existing cases, which assume it is unset).
  let savedEnv: string | undefined;
  beforeEach(() => {
    savedEnv = process.env[CLI_PATH_ENV];
    delete process.env[CLI_PATH_ENV];
    h.resolve = () => {
      throw new Error('not found');
    };
    h.exists = true;
    h.which = null;
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env[CLI_PATH_ENV];
    else process.env[CLI_PATH_ENV] = savedEnv;
  });

  // Purpose: the packaged desktop app hands the server an explicit binary path
  // (require.resolve can't reach the SDK's optional dep there) — it must win
  // over the SDK's own bundled resolution, even when that would also succeed.
  it('prefers the DORKOS_CLAUDE_CLI_PATH override over the bundled binary when the file exists', () => {
    process.env[CLI_PATH_ENV] = '/opt/dorkos/claude';
    h.exists = () => true; // both the override and the bundled path "exist"
    h.resolve = () => '/pkgs/claude-agent-sdk/claude'; // present, but must be ignored
    h.which = '/usr/local/bin/claude'; // present, but must be ignored

    expect(resolveClaudeCliPath()).toBe('/opt/dorkos/claude');
  });

  // Purpose: an override that points at a missing file is not trusted — the
  // existing bundled→PATH→undefined order must resume unchanged.
  it('falls through to the bundled binary when the override path does not exist', () => {
    process.env[CLI_PATH_ENV] = '/opt/dorkos/claude';
    h.exists = (p) => p !== '/opt/dorkos/claude'; // override missing, bundled present
    h.resolve = () => '/pkgs/claude-agent-sdk/claude';
    h.which = null;

    expect(resolveClaudeCliPath()).toBe('/pkgs/claude-agent-sdk/claude');
  });

  // Purpose: a missing override must not mask the terminal `undefined` — the
  // whole order still resolves exactly as it would without the env var set.
  it('with the override missing and nothing else resolvable, returns undefined', () => {
    process.env[CLI_PATH_ENV] = '/opt/dorkos/claude';
    h.exists = () => false; // override missing; bundled resolve throws below
    h.resolve = () => {
      throw new Error('not found');
    };
    h.which = null;

    expect(resolveClaudeCliPath()).toBeUndefined();
  });

  // Purpose: with the override unset (the dev/CLI default), resolution is
  // byte-for-byte the prior behavior — the bundled binary still wins.
  it('ignores an unset override and resolves exactly as before (bundled wins)', () => {
    // beforeEach already deletes the env var.
    h.resolve = () => '/pkgs/claude-agent-sdk/claude';
    h.which = '/usr/local/bin/claude';

    expect(resolveClaudeCliPath()).toBe('/pkgs/claude-agent-sdk/claude');
  });

  // Purpose: prefer the SDK's version-matched bundled binary over an unrelated global install
  it('prefers the bundled native binary when installed', () => {
    h.resolve = (s) => {
      expect(s).toMatch(/^@anthropic-ai\/claude-agent-sdk-.+\/claude(\.exe)?$/);
      return '/pkgs/claude-agent-sdk/claude';
    };
    h.which = '/usr/local/bin/claude'; // present, but must be ignored in favor of the bundled binary

    expect(resolveClaudeCliPath()).toBe('/pkgs/claude-agent-sdk/claude');
  });

  // Purpose: stay working when the optional native-binary dep failed to install
  it('falls back to a PATH `claude` when the bundled binary is absent', () => {
    h.resolve = () => {
      throw new Error('optional dependency not installed');
    };
    h.which = '/usr/local/bin/claude\n'; // raw `which`/`where` output with trailing newline

    expect(resolveClaudeCliPath()).toBe('/usr/local/bin/claude');
  });

  // Purpose: signal "nothing usable" so the dependency check + SDK error can guide the user
  it('returns undefined when neither the bundled binary nor a PATH claude resolve', () => {
    h.resolve = () => {
      throw new Error('not found');
    };
    h.which = null; // execFileSync throws

    expect(resolveClaudeCliPath()).toBeUndefined();
  });

  // Purpose: a resolvable specifier whose file is missing is treated as absent
  it('treats a resolved-but-missing bundled path as absent', () => {
    h.resolve = () => '/pkgs/claude-agent-sdk/claude';
    h.exists = false;
    h.which = null;

    expect(resolveClaudeCliPath()).toBeUndefined();
  });
});

describe('createIdlePrompt — no-turn command probe', () => {
  // Purpose: the probe must NOT enqueue a user turn — it only holds the stream
  // open so the SDK can answer control requests, then completes on close().
  it('yields no user message and completes once close() is called', async () => {
    const { prompt, close } = createIdlePrompt();
    const pull = prompt.next();
    close();
    await expect(pull).resolves.toEqual({ value: undefined, done: true });
  });

  // Purpose: `finally { close() }` may fire after an earlier close — must not throw.
  it('close() is idempotent', async () => {
    const { prompt, close } = createIdlePrompt();
    close();
    close();
    await expect(prompt.next()).resolves.toEqual({ value: undefined, done: true });
  });
});

describe('createHeldUserPrompt — held single-message stream', () => {
  // Purpose: the held prompt (shared core with createIdlePrompt) must still yield
  // exactly one user message before holding the stream open until close().
  it('yields the user message, then completes once close() is called', async () => {
    const { prompt, close } = createHeldUserPrompt('hello');

    const first = await prompt.next();
    expect(first.done).toBe(false);
    expect(first.value).toEqual({
      type: 'user',
      message: { role: 'user', content: 'hello' },
      parent_tool_use_id: null,
      session_id: '',
    });

    // The stream is held open past the message until close() releases it.
    const pull = prompt.next();
    close();
    await expect(pull).resolves.toEqual({ value: undefined, done: true });
  });

  // Purpose: this stamp is the whole basis of turn correlation (DOR-1168). The
  // SDK echoes the message's `uuid` back on the `result` it answers with
  // (`user_message_uuid`), and the windower matches on that id and never on
  // position — so an unstamped message can never have its turn closed.
  it('stamps the server-minted messageId as the SDK message uuid', async () => {
    const { prompt, close } = createHeldUserPrompt('hello', 'msg-42');

    await expect(prompt.next()).resolves.toMatchObject({
      value: { uuid: 'msg-42', message: { content: 'hello' } },
    });
    close();
  });

  // Purpose: an id nobody supplied must not become an empty-string uuid the SDK
  // would echo back and the windower would try to correlate.
  it('carries no uuid at all when no messageId was supplied', async () => {
    const { prompt, close } = createHeldUserPrompt('hello');

    const first = await prompt.next();
    expect(first.value).not.toHaveProperty('uuid');
    close();
  });
});

describe('HeldUserPrompt.push — steering into the live stream', () => {
  // Purpose: DOR-1087 corrective notes ride the held stream mid-turn, so a
  // push must wake a parked consumer, and a push after close must be refused.
  it('delivers a pushed message to a consumer parked on the held stream', async () => {
    const { prompt, close, push } = createHeldUserPrompt('first');
    await prompt.next(); // drain the initial message

    const parked = prompt.next(); // consumer now parked on the hold
    expect(push('steered')).toBe(true);
    const next = await parked;
    expect(next.done).toBe(false);
    expect(next.value?.message.content).toBe('steered');

    const pull = prompt.next();
    close();
    await expect(pull).resolves.toEqual({ value: undefined, done: true });
  });

  it('delivers messages pushed before the consumer catches up, in order', async () => {
    const { prompt, close, push } = createHeldUserPrompt('first');
    expect(push('second')).toBe(true);
    expect(push('third')).toBe(true);

    expect((await prompt.next()).value?.message.content).toBe('first');
    expect((await prompt.next()).value?.message.content).toBe('second');
    expect((await prompt.next()).value?.message.content).toBe('third');
    close();
    await expect(prompt.next()).resolves.toEqual({ value: undefined, done: true });
  });

  // Purpose: a coalesced batch is several ids on one stream, and each message
  // has to carry its OWN. Sharing one id (or dropping the later ones) is what
  // would make a `result` unable to name the message it answered.
  it('stamps each pushed message with its own messageId', async () => {
    const { prompt, close, push } = createHeldUserPrompt('first', 'm1');
    expect(push('second', 'm2')).toBe(true);
    expect(push('third', 'm3')).toBe(true);

    expect((await prompt.next()).value).toMatchObject({ uuid: 'm1' });
    expect((await prompt.next()).value).toMatchObject({ uuid: 'm2' });
    expect((await prompt.next()).value).toMatchObject({ uuid: 'm3' });
    close();
  });

  it('refuses a push after close and sends nothing', async () => {
    const { prompt, close, push } = createHeldUserPrompt('first');
    await prompt.next();
    close();
    expect(push('too late')).toBe(false);
    await expect(prompt.next()).resolves.toEqual({ value: undefined, done: true });
  });

  // Purpose: the pump (spec task 3.2) pushes each dispatch into one long-lived
  // stream, so a burst arriving while the SDK is parked must not reorder. Fails
  // if the queue is ever drained as a stack or a push overwrites a parked slot.
  it('delivers a burst of pushes into a parked consumer in FIFO order', async () => {
    const { prompt, close, push } = createIdlePrompt();
    const seen: string[] = [];
    const consume = (async () => {
      for await (const m of prompt) seen.push(m.message.content);
    })();

    await flushMacrotasks(1); // let the consumer reach the hold
    expect(push('1')).toBe(true);
    expect(push('2')).toBe(true);
    expect(push('3')).toBe(true);
    close();
    await consume;

    expect(seen).toEqual(['1', '2', '3']);
  });
});

/**
 * Yield the event loop `turns` times. Each turn drains the whole microtask
 * queue, so this settles generator resumption deterministically — unlike a
 * timeout, it cannot flake on a loaded machine.
 */
async function flushMacrotasks(turns: number): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve));
}

describe('HeldUserPrompt — who ends the stream', () => {
  // Purpose: close() must not discard what it already accepted. A message
  // pushed before close is a message DorkOS told its caller was delivered
  // (`push` returned true), so dropping it would make that return value a lie.
  it('close() drains messages already accepted, then ends the stream', async () => {
    const { prompt, close, push } = createHeldUserPrompt('a');
    expect(push('b')).toBe(true);
    close();

    const seen: string[] = [];
    for await (const m of prompt) seen.push(m.message.content);

    expect(seen).toEqual(['a', 'b']);
  });

  // Purpose: `finally { close() }` fires on paths where close already ran, and
  // the drain contract above must survive the second call unchanged.
  it('close() is idempotent with a message still queued', async () => {
    const { prompt, close, push } = createHeldUserPrompt('a');
    push('b');
    close();
    close();

    const seen: string[] = [];
    for await (const m of prompt) seen.push(m.message.content);

    expect(seen).toEqual(['a', 'b']);
  });

  // Purpose: the SDK — not DorkOS — owns the consuming loop, and it abandons
  // the stream on abort. Once it has, nothing can reach the model, so `push`
  // must say so. Red before the fix: `push` returned true and the caller
  // (message-sender's phantom correction) counted a note it never sent.
  it('refuses a push once the consumer has broken out of the stream', async () => {
    const { prompt, push } = createHeldUserPrompt('first');

    for await (const m of prompt) {
      expect(m.message.content).toBe('first');
      break; // an early break calls prompt.return() under the hood
    }

    expect(push('nobody is reading')).toBe(false);
  });

  // Purpose: a consumer that stops mid-turn stops while the stream is PARKED —
  // that is what "held open" means. Red before the fix: return() waited on the
  // hold promise nobody would ever resolve, so SDK teardown hung.
  it('return() ends the stream immediately even while it is parked', async () => {
    const { prompt, push } = createHeldUserPrompt('first');
    await prompt.next(); // drain the initial message
    void prompt.next(); // consumer now parked on the hold

    let ended: IteratorResult<unknown> | undefined;
    void prompt.return(undefined).then((r) => {
      ended = r;
    });
    await flushMacrotasks(2);

    expect(ended).toEqual({ value: undefined, done: true });
    expect(push('too late')).toBe(false);
  });

  // Purpose: the asymmetry between the two endings is the contract task 3.2
  // relies on — close() is DorkOS finishing politely and drains; return() is
  // the consumer walking away, so anything still queued is dropped rather than
  // handed to a loop that has already given up. `push` returning true and the
  // message never landing is the one unavoidable race: the stream really was
  // open when it was asked, and the consumer left in the same tick.
  it('return() discards a message pushed in the same tick as the teardown', async () => {
    const { prompt, push } = createHeldUserPrompt('first');
    await prompt.next(); // drain the initial message
    const parked = prompt.next(); // consumer parked on the hold
    expect(push('racing the teardown')).toBe(true);

    await prompt.return(undefined);

    await expect(parked).resolves.toEqual({ value: undefined, done: true });
  });
});
