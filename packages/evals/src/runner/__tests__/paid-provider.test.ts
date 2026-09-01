/**
 * The two locks on the paid external-provider tier, and the sandbox config that
 * points a server at it.
 *
 * The gate is the reason this file exists. A run that reaches an external
 * provider spends money OUTSIDE a Claude subscription, so it needs two
 * independent deliberate acts — the flag AND the key — and each of the four
 * squares of that truth table has to behave, not just the two obvious ones. The
 * dangerous square is "key, no flag": people leave `OPENROUTER_API_KEY` exported
 * because half the toolchain wants it, and if a key alone armed a run then having
 * one would be the same as choosing to spend.
 *
 * WHICH runs count is `spendsOnExternalProvider`, tested at the bottom of this
 * file. It is deliberately not "the tier is `real-provider`" — that phrasing was
 * the hole, and `--tier claude-code-cheap --runtime opencode` walked through it.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  paidProviderNoKeyMessage,
  paidProviderOptInMessage,
  paidProviderRefusesDockerMessage,
  resolvePaidProviderCredential,
  spendsOnExternalProvider,
} from '../credentials.js';
import { defaultRunBudgetUsd } from '../run-suite.js';
import {
  buildOpenCodeSandboxConfig,
  resolveHostOpenCodeBinary,
  writeSandboxConfig,
} from '../opencode-sandbox.js';
import {
  DEFAULT_OPENROUTER_MODEL,
  OPENROUTER_API_KEY_VAR,
  OPENROUTER_PROVIDER_ID,
  PAID_PROVIDER_OPT_IN_VAR,
  PAID_PROVIDER_RUN_BUDGET_USD,
} from '../../types.js';

const KEY = 'sk-or-test-not-a-real-key';

describe('the paid-provider gate', () => {
  it('refuses when nobody asked to spend, even with a key sitting in the environment', () => {
    // THE SQUARE THAT MATTERS. An ambient key is not a decision.
    const gate = resolvePaidProviderCredential({
      optIn: false,
      env: { [OPENROUTER_API_KEY_VAR]: KEY },
    });
    expect(gate.ok).toBe(false);
    expect(gate.ok === false && gate.reason).toBe('no-opt-in');
  });

  it('refuses when nobody asked to spend and there is no key either', () => {
    const gate = resolvePaidProviderCredential({ optIn: false, env: {} });
    expect(gate.ok).toBe(false);
    expect(gate.ok === false && gate.reason).toBe('no-opt-in');
  });

  it('refuses — as an ERROR, not a skip — when somebody asked to spend and gave it nothing', () => {
    // Distinct from the square above on purpose: this person WANTED a paid run,
    // so silence would look like coverage they never got.
    const gate = resolvePaidProviderCredential({ optIn: true, env: {} });
    expect(gate.ok).toBe(false);
    expect(gate.ok === false && gate.reason).toBe('no-key');
  });

  it('treats an empty or whitespace-only key as no key at all', () => {
    expect(
      resolvePaidProviderCredential({ optIn: true, env: { [OPENROUTER_API_KEY_VAR]: '' } }).ok
    ).toBe(false);
    expect(
      resolvePaidProviderCredential({ optIn: true, env: { [OPENROUTER_API_KEY_VAR]: '   ' } }).ok
    ).toBe(false);
  });

  it('arms only when both deliberate acts are present, and hands back a portable credential', () => {
    const gate = resolvePaidProviderCredential({
      optIn: true,
      env: { [OPENROUTER_API_KEY_VAR]: KEY },
    });
    expect(gate.ok).toBe(true);
    if (!gate.ok) return;
    expect(gate.credential.source).toBe('openrouter-api-key');
    expect(gate.credential.env).toEqual({ [OPENROUTER_API_KEY_VAR]: KEY });
    // Portable because it is a VALUE — unlike the local `claude` sign-in, which
    // is a keychain entry only the env-inheriting child-process tier can use.
    expect(gate.credential.portable).toBe(true);
  });

  it('reads only the PINNED variable name, never a caller-named one', () => {
    // `runner/credentials.ts` records why: a caller-named secret input let a
    // dispatcher point a run at any secret in the repo and ship it as an auth
    // header. There is deliberately no seam here to pass a different name through.
    const gate = resolvePaidProviderCredential({
      optIn: true,
      env: { OPENROUTER_KEY: KEY, OPENROUTER_TOKEN: KEY },
    });
    expect(gate.ok).toBe(false);
  });

  it('names both variables in the refusal, so a person can act on it without reading code', () => {
    expect(paidProviderOptInMessage()).toContain(PAID_PROVIDER_OPT_IN_VAR);
    expect(paidProviderOptInMessage()).toContain(OPENROUTER_API_KEY_VAR);
    expect(paidProviderNoKeyMessage()).toContain(OPENROUTER_API_KEY_VAR);
  });

  it('explains that docker is refused because its containers have no network', () => {
    // Not a degrade. An operator who asked for containment must never silently
    // get a bare-host turn instead.
    expect(paidProviderRefusesDockerMessage()).toContain('child-process');
    expect(paidProviderRefusesDockerMessage()).toMatch(/network/i);
  });

  it('keeps the tier ceiling far under the credentialed one', () => {
    // A tripwire for a runaway loop, not an allowance: the pinned model bills
    // fractions of a cent per turn, so reaching this means something looped.
    expect(PAID_PROVIDER_RUN_BUDGET_USD).toBeLessThanOrEqual(0.5);
    expect(PAID_PROVIDER_RUN_BUDGET_USD).toBeGreaterThan(0);
  });
});

describe('the pinned OpenRouter model', () => {
  it('is spelled so OpenCode reads it as the openrouter provider plus a vendor-pathed model', () => {
    // The server half of this pin lives in
    // `apps/server/src/services/runtimes/opencode/__tests__/turn-input.test.ts`,
    // which runs the real `parseModelSelection` over this exact string. This half
    // is what keeps the constant from drifting out from under it.
    const separator = DEFAULT_OPENROUTER_MODEL.indexOf('/');
    expect(DEFAULT_OPENROUTER_MODEL.slice(0, separator)).toBe(OPENROUTER_PROVIDER_ID);
    // The model id itself contains a slash — that is the whole reason the pin
    // needs three segments rather than two.
    expect(DEFAULT_OPENROUTER_MODEL.slice(separator + 1)).toContain('/');
  });

  it('is a concrete paid id, never a `:free` or randomly-routed one', () => {
    // A `:free` id is rate-capped per day, counts failures against the quota, and
    // `openrouter/free` routes to a different model per call — which makes any
    // red unreproducible. See the constant's TSDoc.
    expect(DEFAULT_OPENROUTER_MODEL).not.toContain(':free');
    expect(DEFAULT_OPENROUTER_MODEL).not.toBe('openrouter/free');
  });
});

describe('the OpenCode sandbox config', () => {
  const sections = buildOpenCodeSandboxConfig({
    binaryPath: '/host/.dork/runtimes/opencode/node_modules/.bin/opencode',
    provider: OPENROUTER_PROVIDER_ID,
    model: DEFAULT_OPENROUTER_MODEL,
  });

  it('stores a credential REFERENCE, never the secret itself', () => {
    // The secret travels in the launched server's environment and the server
    // resolves the reference through its own credential port at sidecar spawn
    // (ADR-0315). Nothing here is ever written to disk.
    expect(sections.providers[OPENROUTER_PROVIDER_ID]).toBe(`env:${OPENROUTER_API_KEY_VAR}`);
  });

  it('points the sandbox at the host binary, because its own DORK_HOME has none', () => {
    expect(sections.runtimes.opencode.binaryPath).toBe(
      '/host/.dork/runtimes/opencode/node_modules/.bin/opencode'
    );
    expect(sections.runtimes.opencode.enabled).toBe(true);
    expect(sections.runtimes.opencode.provider).toBe(OPENROUTER_PROVIDER_ID);
    expect(sections.runtimes.opencode.defaultModel).toBe(DEFAULT_OPENROUTER_MODEL);
  });

  it('makes OpenCode the default runtime, so a session created by any path lands there', () => {
    expect(sections.runtimes.default).toBe('opencode');
  });

  it('writes WHOLE sections, so the sibling runtimes survive the write', () => {
    // `conf` merges its defaults at the TOP LEVEL only and `ConfigManager.get`
    // returns the stored value verbatim, so a partial `runtimes` object would
    // silently delete every other runtime's settings.
    expect(sections.runtimes.codex).toBeDefined();
    expect(sections.runtimes.claudeCode).toBeDefined();
  });

  it('round-trips to disk under the config store file name', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'evals-sandbox-config-'));
    try {
      const file = await writeSandboxConfig(path.join(dir, '.dork'), sections);
      expect(path.basename(file)).toBe('config.json');
      const parsed = JSON.parse(await readFile(file, 'utf8')) as typeof sections;
      expect(parsed.runtimes.opencode.defaultModel).toBe(DEFAULT_OPENROUTER_MODEL);
      expect(parsed.providers[OPENROUTER_PROVIDER_ID]).toBe(`env:${OPENROUTER_API_KEY_VAR}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveHostOpenCodeBinary', () => {
  // MIRRORS `resolveProvisionedOpenCodePath()` in
  // `apps/server/src/services/runtimes/opencode/providers/provision.ts`. The
  // runner cannot call that function — it resolves against whatever DORK_HOME the
  // process has, and the eval sandbox's is empty by construction — so the layout
  // is repeated and pinned here instead.
  const expectedSuffix = path.join('runtimes', 'opencode', 'node_modules', '.bin');

  it('looks under the given host home, at the provisioned layout', () => {
    const seen: string[] = [];
    const found = resolveHostOpenCodeBinary({
      dorkHome: '/host/.dork',
      platform: 'darwin',
      exists: (candidate) => {
        seen.push(candidate);
        return true;
      },
    });
    expect(found).toBe(path.join('/host/.dork', expectedSuffix, 'opencode'));
    expect(seen).toHaveLength(1);
  });

  it('asks for the npm `.cmd` shim on Windows', () => {
    const found = resolveHostOpenCodeBinary({
      dorkHome: '/host/.dork',
      platform: 'win32',
      exists: () => true,
    });
    expect(found).toBe(path.join('/host/.dork', expectedSuffix, 'opencode.cmd'));
  });

  it('reports nothing rather than a path that does not exist', () => {
    // The caller turns this into a refusal with an install hint. Handing back a
    // non-existent path would boot a server that registers OpenCode and then
    // fails every turn — a red about the harness dressed as a red about DorkOS.
    expect(
      resolveHostOpenCodeBinary({
        dorkHome: '/host/.dork',
        platform: 'darwin',
        exists: () => false,
      })
    ).toBeUndefined();
  });
});

/**
 * The turbo env firewall, which until now was only a COMMENT.
 *
 * Turbo runs strict: a task sees only the variables it is told to pass through.
 * That is the single reason `pnpm test`, `pnpm verify`, the pre-push hook and CI
 * have never been able to reach a paid path — every spend flag and every model
 * key is stripped before the task starts. "Must be true" is not a property a
 * comment can hold.
 *
 * ## Why this walks the whole file instead of checking three keys
 *
 * The first version of this test enumerated `globalPassThroughEnv`,
 * `tasks.test.env` and `tasks.test.passThroughEnv`, which is three of the ways
 * turbo can expose a variable and not all of them. `globalEnv` exposes one to
 * EVERY task; a package-scoped `@dorkos/evals#test` override, or `test:watch`,
 * or a task these names get added to next year, would each do the same. Adding
 * `OPENROUTER_API_KEY` to `globalEnv` would have opened `pnpm test`, `pnpm
 * verify`, pre-push and CI at a stroke while the guard stayed green — a guard
 * that watches three doors in a building with six.
 *
 * So the assertion is positional-independent: collect every string anywhere in
 * the parsed config and assert none of them is one of these names. A new door
 * is covered the day it is cut.
 */
describe('turbo never hands a spend flag or a model key to any task', () => {
  const turboPath = fileURLToPath(new URL('../../../../../turbo.json', import.meta.url));

  /** Every string value anywhere in a parsed JSON tree, at any depth. */
  function everyString(node: unknown, found: string[] = []): string[] {
    if (typeof node === 'string') found.push(node);
    else if (Array.isArray(node)) for (const item of node) everyString(item, found);
    else if (node && typeof node === 'object') {
      for (const value of Object.values(node)) everyString(value, found);
    }
    return found;
  }

  /**
   * Every name that arms or pays for a real-money path, from AGENTS.md's table.
   * All six, not just the keys: a flag reaching a task is half of an armed gate,
   * and the table in AGENTS.md claims none of them is here.
   */
  const NEVER_IN_TURBO = [
    OPENROUTER_API_KEY_VAR,
    PAID_PROVIDER_OPT_IN_VAR,
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'DORKOS_EVALS_CREDENTIALED',
    'DORKOS_OPENCODE_LIVE_PAID',
  ];

  /**
   * The ONE deliberate exception, pinned by path so it cannot quietly grow.
   *
   * `tasks.e2e.passThroughEnv` carries `ANTHROPIC_API_KEY` on purpose: the
   * Playwright leg can drive a credentialed browser run, and `pnpm test`, `pnpm
   * verify` and the pre-push hook do not run the `e2e` task. Broadening this
   * test is what surfaced it — the previous version enumerated three keys, none
   * of which was this one, and the prose it backed claimed none of these names
   * appeared in turbo.json at all.
   */
  const ALLOWED = { path: 'tasks.e2e.passThroughEnv', name: 'ANTHROPIC_API_KEY' };

  /** Every `dotted.path = value` for a string anywhere in a parsed JSON tree. */
  function everyStringPath(node: unknown, at = '', found: [string, string][] = []) {
    if (typeof node === 'string') found.push([at.replace(/\[\d+\]$/, ''), node]);
    else if (Array.isArray(node)) node.forEach((v, i) => everyStringPath(v, `${at}[${i}]`, found));
    else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) everyStringPath(v, at ? `${at}.${k}` : k, found);
    }
    return found;
  }

  /**
   * Whether a turbo env entry exposes `name`.
   *
   * GLOBS COUNT. `turbo.json` already ships `OTEL_*`, `VITE_*`, `NEXT_PUBLIC_*`
   * and `POSTHOG_*`, so a future `"ANTHROPIC_*"` — or a `"*"` — is an idiomatic
   * addition rather than an exotic one, and an exact-string guard would stay
   * green while it opened every test command at once. The docstring above
   * promises a new door is covered the day it is cut; without this arm that
   * promise was false by exactly one wildcard.
   */
  function exposes(entry: string, name: string): boolean {
    if (entry === name) return true;
    return entry.endsWith('*') && name.startsWith(entry.slice(0, -1));
  }

  it('names none of them on any task the test commands run, at any depth', async () => {
    const turbo: unknown = JSON.parse(await readFile(turboPath, 'utf8'));
    const offenders = everyStringPath(turbo).filter(
      ([at, entry]) =>
        NEVER_IN_TURBO.some((name) => exposes(entry, name)) &&
        !(at === ALLOWED.path && entry === ALLOWED.name)
    );
    expect(
      offenders,
      'a spend flag or model key reached a turbo task; see this file for why that opens every test command at once'
    ).toEqual([]);
  });

  it('catches a wildcard that would expose one of them, not just an exact name', () => {
    // The mutation this guard exists to survive, run against the matcher rather
    // than against the real file: an `ANTHROPIC_*` entry must be an offender.
    expect(exposes('ANTHROPIC_*', 'ANTHROPIC_API_KEY')).toBe(true);
    expect(exposes('DORKOS_*', 'DORKOS_EVALS_PAID_PROVIDER')).toBe(true);
    expect(exposes('*', 'OPENROUTER_API_KEY')).toBe(true);
    // …and the globs turbo.json actually ships must stay innocent.
    expect(exposes('OTEL_*', 'OPENROUTER_API_KEY')).toBe(false);
    expect(exposes('VITE_*', 'ANTHROPIC_API_KEY')).toBe(false);
  });

  it('pins the single deliberate exception, so the carve-out cannot grow silently', async () => {
    const turbo: unknown = JSON.parse(await readFile(turboPath, 'utf8'));
    const allowed = everyStringPath(turbo).filter(([, entry]) =>
      NEVER_IN_TURBO.some((name) => exposes(entry, name))
    );
    // Exactly one, at exactly the path the comment above describes. A second
    // entry — or the same name moving to a task `pnpm test` DOES run — fails here.
    expect(allowed).toEqual([[ALLOWED.path, ALLOWED.name]]);
  });

  it('is reading the real turbo.json, so a moved file cannot make this vacuous', async () => {
    // Without this, a renamed or moved config would turn the assertion above
    // into "no strings, so no bad strings" — green forever, watching nothing.
    const turbo = JSON.parse(await readFile(turboPath, 'utf8')) as {
      tasks?: Record<string, unknown>;
    };
    expect(turbo.tasks?.test).toBeDefined();
    const strings = everyString(turbo);
    expect(strings.length).toBeGreaterThan(20);
    // A positive control: the file DOES carry pass-through names, so the
    // assertion above is discriminating between names rather than finding none.
    expect(strings).toContain('DORK_HOME');
  });
});

/**
 * The predicate the whole gate hangs on, tested directly.
 *
 * It had no test at all, which is how it could have been quietly rewritten back
 * into a tier check: `run-suite` and `run-eval` both call it, but every test that
 * reaches those goes through the module-scope opt-in flag, so the SHAPE of the
 * rule was only ever asserted end-to-end on the refusal side. A table on the pure
 * function is what makes "the gate follows the money" a pinned property rather
 * than a sentence in a commit message.
 */
describe('spendsOnExternalProvider — the rule the gate keys on', () => {
  /** `[tier, runtime, provider, spends?, why]` — annotated so `it.each` keeps one signature. */
  const cases: [string, string | undefined, string | undefined, boolean, string][] = [
    ['real-provider', 'opencode', 'openrouter', true, 'the ordinary paid run'],
    ['real-provider', undefined, undefined, true, 'the tier alone still gates'],
    // THE 🔴: a cheap tier reaching OpenRouter through --runtime.
    ['claude-code-cheap', 'opencode', undefined, true, 'OpenCode always fronts a provider'],
    ['claude-code-cheap', 'opencode', 'openrouter', true, 'the reviewer’s exact command'],
    // Naming a provider is asking to spend on one, whatever sits beside it.
    ['claude-code-cheap', 'claude-code', 'openrouter', true, 'an explicit provider gates'],
    ['claude-code-cheap', undefined, 'openrouter', true, 'a provider with no runtime gates'],
    // The negative controls that keep this from being "refuse everything".
    ['claude-code-cheap', 'claude-code', undefined, false, 'the ordinary Anthropic run'],
    ['claude-code-cheap', 'codex', undefined, false, 'codex uses its own delegated login'],
    ['test-mode', undefined, undefined, false, 'the free structural run'],
  ];

  it.each(cases)('%s + %s + %s → %s (%s)', (tier, runtime, provider, expected) => {
    expect(spendsOnExternalProvider(tier, runtime, provider)).toBe(expected);
  });
});

describe('defaultRunBudgetUsd — the ceiling follows the same rule', () => {
  it('gives a spend-reaching run the tight tripwire, on any tier', () => {
    // The branch no end-to-end test can reach (arming needs the un-stubbable
    // module-scope flag), and the one a "simplification" back to `paid ? …`
    // would silently break — an armed cheap-tier OpenCode run would regain the
    // $3 ceiling while spending on OpenRouter.
    expect(defaultRunBudgetUsd('real-provider', 'opencode', 'openrouter')).toBe(
      PAID_PROVIDER_RUN_BUDGET_USD
    );
    expect(defaultRunBudgetUsd('claude-code-cheap', 'opencode', 'openrouter')).toBe(
      PAID_PROVIDER_RUN_BUDGET_USD
    );
    expect(defaultRunBudgetUsd('claude-code-cheap', undefined, 'openrouter')).toBe(
      PAID_PROVIDER_RUN_BUDGET_USD
    );
  });

  it('leaves a run that reaches no provider on the credentialed default', () => {
    expect(defaultRunBudgetUsd('claude-code-cheap', 'claude-code', undefined)).toBe(3);
    expect(defaultRunBudgetUsd('test-mode', undefined, undefined)).toBe(3);
  });

  it('keeps the two ceilings far apart, so the tripwire is actually tighter', () => {
    expect(PAID_PROVIDER_RUN_BUDGET_USD).toBeLessThan(
      defaultRunBudgetUsd('claude-code-cheap', 'claude-code', undefined)
    );
  });
});
