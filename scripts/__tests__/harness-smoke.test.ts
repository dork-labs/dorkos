/**
 * The real-harness smoke, tested without a real harness.
 *
 * `scripts/harness-smoke/` exists to drive a `claude`, `codex` or `opencode`
 * binary against a projected tree. That leaves the runner itself untested by
 * construction — a bug in its gate, its oracles or its report would only ever
 * surface on a run that costs money and needs a binary CI does not have. So
 * every path here is exercised against `harness-smoke/fake-harness.ts`, which
 * discovers the fixture through each harness's own documented read paths rather
 * than being told the answers.
 *
 * ## The half that matters most is the gate
 *
 * This runner is the FOURTH money path in the repo (`AGENTS.md`). The dangerous
 * square of its truth table is "key, no flag": people leave `ANTHROPIC_API_KEY`
 * and `OPENAI_API_KEY` exported because half a toolchain wants one, and if a key
 * alone armed a run then having one would be the same as choosing to spend. All
 * four squares are pinned below, plus the two this repo's history makes
 * specific: a sign-in sitting on the machine is not an instrument, and one
 * harness's key does not arm another's.
 *
 * Nothing here sets `DORKOS_HARNESS_SMOKE` or any real key. The gate's flag is
 * read once at module scope on purpose (so no `vi.stubEnv` can blank it), and
 * every test drives the injected `optIn` seam instead.
 */
import { describe, it, expect } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check as prettierCheck } from 'prettier';
import { noBinaryMessage, resolveFreeGate, resolveSmokeGate } from '../harness-smoke/gate.js';
import {
  HARNESS_SMOKE_OPT_IN_VAR,
  SMOKE_HARNESSES,
  SMOKE_HARNESS_IDS,
  parseClaudeStream,
  parseCodexPromptInput,
} from '../harness-smoke/harnesses.js';
import { ceilingVerdict, listingVerdicts } from '../harness-smoke/oracles.js';
import { renderRunReport, renderSkipReport, reportFileName } from '../harness-smoke/report.js';
import { DEFAULT_MAX_USD, parseArgs, probeEnv, processStarted } from '../harness-smoke/run.js';
import {
  INSTRUCTIONS_SENTINEL,
  fixtureSpecFor,
  probeSkillBody,
  stageSmokeFixture,
} from '../harness-smoke/fixture.js';
import { FIXTURE_SENTINEL } from '../harness-smoke/fake-harness.js';

const CLAUDE = SMOKE_HARNESSES.claude;
const CODEX = SMOKE_HARNESSES.codex;
const OPENCODE = SMOKE_HARNESSES.opencode;

/** A key that reaches nothing: every test that uses one also passes `--binary`. */
const FAKE_KEY = 'not-a-real-key-fake-binary-only';

// ─────────────────────────────────────────────────────────────────────────────
// The gate
// ─────────────────────────────────────────────────────────────────────────────

describe('the money gate', () => {
  it('refuses when nobody asked to spend, even with the key sitting in the environment', () => {
    // THE SQUARE THAT MATTERS. An ambient key is not a decision.
    const gate = resolveSmokeGate(CLAUDE, {
      optIn: false,
      env: { ANTHROPIC_API_KEY: FAKE_KEY },
      findBinary: () => '/usr/local/bin/claude',
    });
    expect(gate.ok).toBe(false);
    expect(gate.ok === false && gate.reason).toBe('no-opt-in');
    expect(gate.ok === false && gate.message).toContain(HARNESS_SMOKE_OPT_IN_VAR);
    expect(gate.ok === false && gate.message).toContain('ANTHROPIC_API_KEY');
  });

  it('refuses when somebody asked to spend and named no instrument', () => {
    const gate = resolveSmokeGate(CLAUDE, {
      optIn: true,
      env: {},
      findBinary: () => '/usr/local/bin/claude',
    });
    expect(gate.ok).toBe(false);
    expect(gate.ok === false && gate.reason).toBe('no-key');
    expect(gate.ok === false && gate.message).toContain('ANTHROPIC_API_KEY');
  });

  it('does not treat a sign-in sitting on the machine as an instrument', () => {
    // Every one of these is a way an agent on this machine reaches a model every
    // day, and not one of them may arm a smoke: the run would bill the
    // operator's own subscription for something nobody asked for, and could not
    // even say which credential paid. The gate reads ONE name.
    const ambient = {
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-something',
      CLAUDE_CONFIG_DIR: '/Users/somebody/.claude',
      CODEX_HOME: '/Users/somebody/.codex',
      HOME: '/Users/somebody',
    };
    for (const harness of Object.values(SMOKE_HARNESSES)) {
      const gate = resolveSmokeGate(harness, {
        optIn: true,
        env: ambient,
        findBinary: () => `/usr/local/bin/${harness.binary}`,
      });
      expect(gate.ok, `${harness.id} must not arm on an ambient sign-in`).toBe(false);
      expect(gate.ok === false && gate.reason).toBe('no-key');
    }
  });

  it('does not let one harness’s key arm another’s run', () => {
    // The three names are distinct instruments billing three different accounts.
    // A shared read would let an exported OPENAI_API_KEY spend on Anthropic.
    const everyKey = {
      ANTHROPIC_API_KEY: FAKE_KEY,
      OPENAI_API_KEY: FAKE_KEY,
      OPENROUTER_API_KEY: FAKE_KEY,
    };
    for (const harness of Object.values(SMOKE_HARNESSES)) {
      const onlyOthers = { ...everyKey };
      delete onlyOthers[harness.keyVar as keyof typeof onlyOthers];
      const gate = resolveSmokeGate(harness, {
        optIn: true,
        env: onlyOthers,
        findBinary: () => `/usr/local/bin/${harness.binary}`,
      });
      expect(gate.ok, `${harness.id} armed on another harness's key`).toBe(false);
      expect(gate.ok === false && gate.reason).toBe('no-key');
    }
  });

  it('treats an empty or whitespace-only key as no key at all', () => {
    for (const value of ['', '   ']) {
      const gate = resolveSmokeGate(CLAUDE, {
        optIn: true,
        env: { ANTHROPIC_API_KEY: value },
        findBinary: () => '/usr/local/bin/claude',
      });
      expect(gate.ok).toBe(false);
      expect(gate.ok === false && gate.reason).toBe('no-key');
    }
  });

  it('skips — naming the binary — when both acts are present and the harness is not installed', () => {
    const gate = resolveSmokeGate(OPENCODE, {
      optIn: true,
      env: { OPENROUTER_API_KEY: FAKE_KEY },
      findBinary: () => undefined,
    });
    expect(gate.ok).toBe(false);
    expect(gate.ok === false && gate.reason).toBe('no-binary');
    expect(gate.ok === false && gate.message).toContain('`opencode`');
    expect(gate.ok === false && gate.message).toContain('--binary');
  });

  it('arms only when both deliberate acts and the binary are present', () => {
    const gate = resolveSmokeGate(CODEX, {
      optIn: true,
      env: { OPENAI_API_KEY: FAKE_KEY },
      findBinary: () => '/usr/local/bin/codex',
    });
    expect(gate.ok).toBe(true);
    expect(gate.ok === true && gate.key).toBe(FAKE_KEY);
    expect(gate.ok === true && gate.binaryPath).toBe('/usr/local/bin/codex');
  });

  it('asks for the flag BEFORE the key, so an unarmed machine is never probed for secrets', () => {
    // Order is policy, not style: reporting `no-key` on an unarmed machine would
    // tell somebody who never asked to spend which secret to go and export.
    const gate = resolveSmokeGate(CLAUDE, { optIn: false, env: {}, findBinary: () => undefined });
    expect(gate.ok === false && gate.reason).toBe('no-opt-in');
  });

  it('pins one distinct instrument per harness, and no fourth name', () => {
    // A guard enumerated from the source of truth, never from a literal list:
    // a harness added without an instrument, or sharing one, reds here.
    const keys = Object.values(SMOKE_HARNESSES).map((harness) => harness.keyVar);
    expect(keys).toEqual(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY']);
    expect(new Set(keys).size).toBe(keys.length);
    expect(Object.keys(SMOKE_HARNESSES)).toEqual([...SMOKE_HARNESS_IDS]);
  });

  it('names the missing binary in the message rather than saying "not found"', () => {
    expect(noBinaryMessage(CLAUDE)).toContain('`claude`');
    expect(noBinaryMessage(CODEX)).toContain('`codex`');
  });

  it('checks an explicit --binary for executability instead of taking it on trust', () => {
    // `spawnSync` reports a missing binary the same way it reports a timeout
    // kill — `status: null` — so an unchecked override turned a typo in a path
    // into "the turn never exited; it was killed after 300s".
    const gate = resolveSmokeGate(CLAUDE, {
      optIn: true,
      env: { ANTHROPIC_API_KEY: FAKE_KEY },
      binaryOverride: join(tmpdir(), 'definitely-not-a-binary-8f21'),
    });
    expect(gate.ok).toBe(false);
    expect(gate.ok === false && gate.reason).toBe('no-binary');
    expect(gate.ok === false && gate.message).toContain('definitely-not-a-binary-8f21');
  });

  it('accepts an executable --binary, and never consults PATH when one is given', () => {
    const dir = mkdtempSync(join(tmpdir(), 'smoke-bin-'));
    const path = join(dir, 'stand-in');
    writeFileSync(path, '#!/bin/sh\nexit 0\n');
    chmodSync(path, 0o755);
    let pathWasConsulted = false;
    const gate = resolveSmokeGate(CLAUDE, {
      optIn: true,
      env: { ANTHROPIC_API_KEY: FAKE_KEY },
      binaryOverride: path,
      findBinary: () => {
        pathWasConsulted = true;
        return '/usr/local/bin/claude';
      },
    });
    expect(gate.ok === true && gate.binaryPath).toBe(path);
    expect(pathWasConsulted).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('the free gate', () => {
  it('needs neither the flag nor a key, because it reaches no model', () => {
    const gate = resolveFreeGate(CLAUDE, { env: {}, findBinary: () => '/usr/local/bin/claude' });
    expect(gate.ok).toBe(true);
  });

  it('still needs the binary, and says which one', () => {
    const gate = resolveFreeGate(CLAUDE, { findBinary: () => undefined });
    expect(gate.ok).toBe(false);
    expect(gate.ok === false && gate.reason).toBe('no-binary');
  });

  it('refuses a harness with no free probe rather than inventing one', () => {
    const gate = resolveFreeGate(OPENCODE, { findBinary: () => '/usr/local/bin/opencode' });
    expect(gate.ok).toBe(false);
    expect(gate.ok === false && gate.reason).toBe('no-free-probe');
    expect(gate.ok === false && gate.message).toContain('OPENROUTER_API_KEY');
  });

  it('describes a free probe only where one was measured', () => {
    // Guard against the cheerful direction: a `turn-init` cell claims a binary
    // prints its listing before its first API request, which is a measurement,
    // not a guess.
    expect(CLAUDE.free.kind).toBe('turn-init');
    expect(CODEX.free.kind).toBe('listing-only');
    expect(OPENCODE.free.kind).toBe('none');
    expect(CLAUDE.free.kind === 'turn-init' && CLAUDE.free.env.ANTHROPIC_BASE_URL).toBe(
      'http://127.0.0.1:1'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The ceiling
// ─────────────────────────────────────────────────────────────────────────────

describe('a probe that did not finish', () => {
  it('separates a timeout kill from a process that never started', () => {
    // A `--free` Claude Code turn is ALWAYS killed by the timeout — that is its
    // design, and its hooks and session-init message arrive long before the
    // kill. Treating that as "never ran" reported every free run's hook verdicts
    // as NOT RUN while the hooks had demonstrably fired. `spawnSync` reports a
    // missing binary and a timeout kill both through `status: null`, so the
    // error code is the only discriminator there is.
    expect(processStarted({})).toBe(true);
    expect(
      processStarted({ error: { message: 'spawnSync claude ETIMEDOUT', code: 'ETIMEDOUT' } })
    ).toBe(true);
    expect(processStarted({ error: { message: 'spawnSync claude ENOENT', code: 'ENOENT' } })).toBe(
      false
    );
    // A spawn error with no code is the conservative case: assume nothing ran.
    // An oracle reported off a process that did not exist is worse than one
    // reported as NOT RUN.
    expect(processStarted({ error: { message: 'something went wrong' } })).toBe(false);
  });
});

describe('the ceiling', () => {
  it('defaults to 0.50 USD — a tripwire, not an allowance', () => {
    expect(DEFAULT_MAX_USD).toBe(0.5);
    const parsed = parseArgs(['claude'], '/reports');
    expect(parsed.ok && parsed.options.maxUsd).toBe(0.5);
  });

  it('takes --max-usd', () => {
    const parsed = parseArgs(['claude', '--max-usd', '0.10'], '/reports');
    expect(parsed.ok && parsed.options.maxUsd).toBe(0.1);
  });

  it('pins each harness to a cheap model, with a stated reason, and takes an override', () => {
    // A run that costs "fractions of a cent" is a claim about a MODEL, and the
    // reason has to be citable — the Codex catalog carries no prices, so its
    // cell is a reading of the vendor's own descriptions and says so.
    for (const harness of Object.values(SMOKE_HARNESSES)) {
      expect(harness.model.id, `${harness.id} needs a pinned model`).not.toBe('');
      expect(harness.model.why.length, `${harness.id} needs a reason`).toBeGreaterThan(40);
    }
    expect(CLAUDE.model.id).toBe('claude-haiku-4-5-20251001');
    const parsed = parseArgs(['codex', '--model', 'gpt-5.4-mini'], '/reports');
    expect(parsed.ok && parsed.options.model).toBe('gpt-5.4-mini');
    expect(parseArgs(['codex', '--model'], '/reports').ok).toBe(false);
  });

  it('reaches the pinned model on the command line of every harness', () => {
    for (const harness of Object.values(SMOKE_HARNESSES)) {
      const args = harness.turnProbe({
        repoRoot: '/repo',
        binaryPath: `/usr/local/bin/${harness.binary}`,
        prompt: 'hi',
        noncesDir: '/sandbox/nonces',
        model: 'chosen-model',
        maxUsd: 0.25,
      }).args;
      expect(args, `${harness.id} must pass its model`).toContain(harness.model.flag);
      expect(args[args.indexOf(harness.model.flag) + 1]).toBe('chosen-model');
    }
  });

  it('refuses a ceiling that is not a positive number, rather than coercing it', () => {
    // `--max-usd abc` coerced to NaN compares false against every cost and would
    // therefore refuse NOTHING — the dangerous direction, and the reason this is
    // a parse error rather than a fallback.
    for (const value of ['abc', '0', '-1', '']) {
      const parsed = parseArgs(['claude', '--max-usd', value], '/reports');
      expect(parsed.ok, `--max-usd ${value} must be refused`).toBe(false);
    }
    expect(parseArgs(['claude', '--max-usd'], '/reports').ok).toBe(false);
  });

  it('reaches the binary that enforces one', () => {
    const args = CLAUDE.turnProbe({
      repoRoot: '/repo',
      binaryPath: '/usr/local/bin/claude',
      prompt: 'hi',
      noncesDir: '/sandbox/nonces',
      model: 'a-model',
      maxUsd: 0.25,
    }).args;
    expect(args).toContain('--max-budget-usd');
    expect(args[args.indexOf('--max-budget-usd') + 1]).toBe('0.25');
  });

  it('tells every sandboxing harness that the nonce directory is writable', () => {
    // The nonces sit OUTSIDE the fixture on purpose. Codex confines a model's
    // shell to the workspace under `--sandbox workspace-write`, so without this
    // the `touch` is refused and the activation oracle reports a defect the
    // projection does not have — a red about the probe dressed as a red about
    // DorkOS.
    for (const harness of [CLAUDE, CODEX]) {
      const args = harness.turnProbe({
        repoRoot: '/repo',
        binaryPath: `/usr/local/bin/${harness.binary}`,
        prompt: 'hi',
        noncesDir: '/sandbox/nonces',
        model: 'a-model',
        maxUsd: 0.25,
      }).args;
      expect(args, `${harness.id} must allow writes to the nonce directory`).toContain('--add-dir');
      expect(args[args.indexOf('--add-dir') + 1]).toBe('/sandbox/nonces');
    }
  });

  it('leaves the skill-invoking tool in place while denying every file-read route', () => {
    // Denying `Skill` would make a healthy harness look broken: it is how a
    // skill is invoked at all. Denying the read routes is what makes the nonce
    // evidence of INJECTION rather than of the model opening the file.
    const args = CLAUDE.turnProbe({
      repoRoot: '/repo',
      binaryPath: '/usr/local/bin/claude',
      prompt: 'hi',
      noncesDir: '/sandbox/nonces',
      model: 'a-model',
      maxUsd: 0.25,
    }).args;
    expect(args[args.indexOf('--tools') + 1]).toBe('Bash,Skill');
    for (const denied of ['Bash(cat:*)', 'Bash(sed:*)', 'Bash(grep:*)']) {
      expect(args).toContain(denied);
    }
  });

  it('fails a run whose reported cost breached it', () => {
    const verdict = ceilingVerdict(CLAUDE, { startupSeen: true, text: '', costUsd: 0.9 }, 0.5);
    expect(verdict.status).toBe('fail');
    expect(verdict.detail).toContain('0.9000');
  });

  it('passes a run under it, and says the exact number', () => {
    const verdict = ceilingVerdict(CLAUDE, { startupSeen: true, text: '', costUsd: 0.003 }, 0.5);
    expect(verdict.status).toBe('pass');
    expect(verdict.detail).toContain('0.0030');
  });

  it('says plainly that a harness with no cost report enforced ONE TURN, not a dollar figure', () => {
    // The honest half. Reporting `pass` here would claim a ceiling nobody held.
    const verdict = ceilingVerdict(CODEX, { startupSeen: false, text: '' }, 0.5);
    expect(verdict.status).toBe('unknown');
    expect(verdict.detail).toContain('ONE turn');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The parsers, against the real formats
// ─────────────────────────────────────────────────────────────────────────────

describe('the stream parsers', () => {
  it('reads Claude Code’s init line for the listing and the credential source', () => {
    // The shape is copied from the recorded SDK fixture
    // `apps/server/.../fixtures/delivery-segment-sdk-0.3.224.jsonl`.
    const stream = [
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        slash_commands: ['x', 'pkg:x'],
        skills: ['x'],
        apiKeySource: 'ANTHROPIC_API_KEY',
      }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'bye', total_cost_usd: 0.02 }),
    ].join('\n');
    const turn = parseClaudeStream(stream);
    expect(turn.listing?.commands).toEqual(['x', 'pkg:x']);
    expect(turn.listing?.skills).toEqual(['x']);
    expect(turn.credentialSource).toBe('ANTHROPIC_API_KEY');
    expect(turn.costUsd).toBe(0.02);
    expect(turn.text).toContain('hi');
    expect(turn.text).toContain('bye');
  });

  it('survives the non-JSON noise a CLI writes between records', () => {
    const turn = parseClaudeStream(
      'warning: something\n\n{"type":"result","total_cost_usd":0.01}\n'
    );
    expect(turn.costUsd).toBe(0.01);
  });

  it('reads Codex’s prompt-input JSON, keyed by frontmatter name with its file path', () => {
    // Copied from a real `codex debug prompt-input` run (codex-cli 0.145.0).
    const stdout = JSON.stringify([
      {
        type: 'message',
        role: 'developer',
        content: [
          {
            type: 'input_text',
            text:
              '<skills_instructions>\n### Available skills\n' +
              '- x: The packaged x skill (file: /repo/.agents/skills/pkg__x/SKILL.md)\n' +
              '- x: The x skill (file: /repo/.agents/skills/x/SKILL.md)\n',
          },
        ],
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '<INSTRUCTIONS>\nHouse rules.\n</INSTRUCTIONS>' }],
      },
    ]);
    const listing = parseCodexPromptInput(stdout);
    expect(listing.skills).toEqual(['x', 'x']);
    expect(listing.skillPaths).toEqual([
      '/repo/.agents/skills/pkg__x/SKILL.md',
      '/repo/.agents/skills/x/SKILL.md',
    ]);
    expect(listing.instructions).toContain('House rules.');
    // Codex has no repo-local command format at all.
    expect(listing.commands).toEqual([]);
  });

  it('answers with nothing rather than throwing on output that is not JSON', () => {
    expect(parseCodexPromptInput('error: not signed in')).toEqual({
      skills: [],
      commands: [],
      skillPaths: [],
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The fixture
// ─────────────────────────────────────────────────────────────────────────────

describe('the fixture', () => {
  it('stages the shapes §8 lists, and projects them with the real engine', () => {
    const fixture = stageSmokeFixture(CLAUDE);
    try {
      const exists = (path: string): boolean => existsSync(join(fixture.repoRoot, path));
      // The canonical skill, reached by Claude Code only through the symlink.
      expect(exists('.claude/skills/x/SKILL.md')).toBe(true);
      // The installed package's skill, namespaced, in BOTH roots (SK-02).
      expect(exists('.claude/skills/pkg__x/SKILL.md')).toBe(true);
      expect(exists('.agents/skills/pkg__x/SKILL.md')).toBe(true);
      // The command wrapper that shares its leaf name with both (CM-05).
      expect(exists('.claude/commands/pkg/x.md')).toBe(true);
      // The instructions pointer.
      expect(readFileSync(join(fixture.repoRoot, '.claude/CLAUDE.md'), 'utf8')).toContain(
        '@../AGENTS.md'
      );
      expect(readFileSync(join(fixture.repoRoot, 'AGENTS.md'), 'utf8')).toContain(
        INSTRUCTIONS_SENTINEL
      );
      // The PROJECTED hook — the one §8 asks Claude Code about.
      const local = readFileSync(join(fixture.repoRoot, '.claude/settings.local.json'), 'utf8');
      expect(local).toContain('_dorkosHarness');
      expect(local).toContain(fixture.pluginHookNonce);
    } finally {
      fixture.cleanup();
    }
  });

  it('gives OpenCode the CLAUDE.md-only tree §8 asks it about, and nobody else', () => {
    // Two mutually exclusive questions: `AGENTS.md` present for Claude Code and
    // Codex, absent for OpenCode's documented fallback.
    const openSpec = fixtureSpecFor(OPENCODE, { authoredHook: '/a', pluginHook: '/b' });
    expect(openSpec.agents?.agentsMd).toBeUndefined();
    expect(openSpec.claude?.rootClaudeMd).toContain(INSTRUCTIONS_SENTINEL);
    const codexSpec = fixtureSpecFor(CODEX, { authoredHook: '/a', pluginHook: '/b' });
    expect(codexSpec.agents?.agentsMd).toContain(INSTRUCTIONS_SENTINEL);
    expect(codexSpec.claude?.rootClaudeMd).toBeUndefined();
  });

  it('enables Claude Code alongside every other harness, so SK-12’s double reach exists', () => {
    expect(
      fixtureSpecFor(OPENCODE, { authoredHook: '/a', pluginHook: '/b' }).manifest
    ).toMatchObject({
      harnesses: ['claude-code', 'opencode'],
    });
  });

  it('writes a probe skill whose body is one instruction and nothing else', () => {
    const body = probeSkillBody('/tmp/nonce with space');
    expect(body).toContain("touch '/tmp/nonce with space'");
    expect(body.split('\n').filter((line) => line.startsWith('Run '))).toHaveLength(1);
  });

  it('quotes a nonce path so a space in a temp directory cannot split the command', () => {
    const spec = fixtureSpecFor(CLAUDE, { authoredHook: '/tmp/a b/c', pluginHook: '/tmp/d' });
    const command = spec.claude?.settingsHooks?.SessionStart?.[0]?.hooks[0]?.command;
    expect(command).toBe("touch '/tmp/a b/c'");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The report
// ─────────────────────────────────────────────────────────────────────────────

describe('the report', () => {
  const skip = renderSkipReport(CLAUDE, '2026-09-09T05:42:12.000Z', 'no-opt-in', 'because reasons');

  it('names the harness, the reason, and both variables, and says nothing was billed', () => {
    expect(skip).toContain('# Harness Smoke — Claude Code — 2026-09-09 05:42');
    expect(skip).toContain('SKIPPED (`no-opt-in`)');
    expect(skip).toContain('because reasons');
    expect(skip).toContain('DORKOS_HARNESS_SMOKE=1 ANTHROPIC_API_KEY=<key>');
    expect(skip).toContain('no stored sign-in was read');
  });

  it('says out loud that a skip proves nothing about the rows it was meant to prove', () => {
    // The failure this repo has already had once: a directory of files that all
    // look like results, one of which covered nothing.
    expect(skip).toContain('It proves NOTHING about SK-08, SK-09, SK-12, CM-05 or HK-01');
  });

  it('names its file after the run and the harness, so a directory sorts by time', () => {
    expect(reportFileName('2026-09-09T05:42:12.000Z', 'codex')).toBe(
      '20260909-054212.000-codex.md'
    );
  });

  it('keeps milliseconds, so two runs a second apart cannot overwrite each other', () => {
    // The documented workflow is `--free` and then a paid run of the SAME
    // harness. At second granularity the second one silently replaced the first.
    const first = reportFileName('2026-09-09T05:42:12.000Z', 'claude');
    const second = reportFileName('2026-09-09T05:42:12.400Z', 'claude');
    expect(first).not.toBe(second);
  });

  it('cites a capability id on every verdict that is evidence about one', () => {
    const report = renderRunReport({
      harness: CODEX,
      startedAt: '2026-09-09T05:42:12.000Z',
      maxUsd: 0.5,
      free: false,
      pinnedModel: CODEX.model.id,
      notRun: [],
      verdicts: listingVerdicts(CODEX, { skills: [], commands: [], skillPaths: [] }, '/repo'),
      calibration: [{ side: 'coverage-only', key: 'x', where: '.agents/skills/x/SKILL.md' }],
      applied: ['codex generate hook .codex/hooks.json'],
    });
    expect(report).toContain('SK-06, SK-09');
    expect(report).toContain('The coverage walk discovered `x`');
    expect(report).toContain('codex generate hook .codex/hooks.json');
    expect(report).toContain('`codex debug prompt-input` — non-model, so it costs nothing');
  });

  it('is Prettier-clean, because `test-results/` is not in .prettierignore', () => {
    // A generated report goes through the same `prettier --check` gate as source
    // (the Formatting step of the required `lint` workflow), so a report that
    // needed reformatting would red that gate for anybody who ran the smoke.
    // This is also why the renderers use lists and never markdown tables:
    // Prettier realigns table columns.
    return expect(prettierCheck(skip, { parser: 'markdown', printWidth: 100 })).resolves.toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The curated child environment
// ─────────────────────────────────────────────────────────────────────────────

describe('the environment a probe is launched with', () => {
  const env = probeEnv(CLAUDE, FAKE_KEY, '/sandbox', {});

  it('is built, never inherited — nothing that could reach a model leaks in', () => {
    expect(Object.keys(env).sort()).toEqual([
      'ANTHROPIC_API_KEY',
      'CLAUDE_CONFIG_DIR',
      'HOME',
      'LANG',
      'PATH',
      'TMPDIR',
    ]);
  });

  it('points HOME at the run’s own empty sandbox', () => {
    // Containment AND correctness: it keeps the operator's `~/.agents/skills` and
    // `~/.claude/skills` out of the fixture's answer, and it means a harness that
    // decided to write to its user config writes into a directory this run deletes.
    expect(env.HOME).toBe('/sandbox');
    expect(env.CLAUDE_CONFIG_DIR).toBe('/sandbox');
    expect(probeEnv(CODEX, FAKE_KEY, '/sandbox', {}).CODEX_HOME).toBe('/sandbox');
  });

  it('carries exactly one instrument, and it is this harness’s', () => {
    expect(env.ANTHROPIC_API_KEY).toBe(FAKE_KEY);
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Drift guards
// ─────────────────────────────────────────────────────────────────────────────

describe('drift guards', () => {
  it('keeps the fake’s copy of the sentinel equal to the fixture’s', () => {
    // The fake stands in for a BINARY, so it imports nothing from the engine.
    // That copy is the price, and this is what stops it drifting.
    expect(FIXTURE_SENTINEL).toBe(INSTRUCTIONS_SENTINEL);
  });

  it('keeps every harness honest about whether it has a listing surface', () => {
    // A cell that says `non-model` must carry the command; one that says
    // `unknown` must say it was not measured, never guess.
    expect(CODEX.listing).toMatchObject({ kind: 'non-model', command: 'codex debug prompt-input' });
    expect(CLAUDE.listing.kind).toBe('in-turn');
    expect(OPENCODE.listing.kind).toBe('unknown');
    for (const harness of Object.values(SMOKE_HARNESSES)) {
      expect(harness.listing.note.length, `${harness.id} needs a reason`).toBeGreaterThan(40);
      expect(Boolean(harness.listingProbe)).toBe(harness.listing.kind === 'non-model');
      expect(Boolean(harness.parseListing)).toBe(harness.listing.kind === 'non-model');
    }
  });
});
