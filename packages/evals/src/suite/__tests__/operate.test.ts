/**
 * Deterministic guard for the operate-DorkOS cases (DOR-435) — their METADATA,
 * their SEEDs, and their ORACLES, all without a model. Each case's real run
 * needs a credentialed model (choosing an MCP tool from natural language is
 * model behavior); this test proves the plumbing around it: the seeds lay down
 * the exact on-disk state a credentialed run reads, and every oracle has a
 * genuine PASS and a genuine FAIL (so a broken always-pass oracle is caught,
 * per the harness's oracle-test discipline). Tool-use oracles are exercised
 * with fabricated `tool_call` frames; filesystem oracles by writing the state
 * the agent would produce.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildSoulContent } from '@dorkos/shared/convention-files';
import { renderTraits, DEFAULT_TRAITS } from '@dorkos/shared/trait-renderer';
import type { SseFrame } from '@dorkos/test-utils/sse-test-helpers';
import type {
  ApprovalDriverLog,
  EvalCase,
  EvalSandbox,
  OracleContext,
  OracleResult,
} from '../../types.js';
import { emptyApprovalLog } from '../../types.js';
import {
  agentSelfEditCase,
  activityReadCase,
  configToggleCase,
  marketplaceInstallCase,
  capabilityDiscoveryCase,
  operateDorkOsCases,
} from '../operate.js';

let sandbox: EvalSandbox;
let root: string;

/**
 * An OracleContext over the seeded sandbox with an optional transcript and
 * approval log.
 *
 * `approvals` is REQUIRED on the real contract and the runner always supplies it
 * (`emptyApprovalLog()` when a case carries no policy), so this helper does the
 * same. Defaulting it to an empty log rather than leaving it out is what lets an
 * oracle that reads it fail with a verdict instead of a TypeError.
 */
function ctx(
  frames: SseFrame[] = [],
  approvals: ApprovalDriverLog = emptyApprovalLog()
): OracleContext {
  return { sandbox, baseUrl: 'http://unused', sessionId: 's', frames, approvals };
}

/** An approval log in which a person granted `capabilityId` before anything had happened. */
function grantedBeforeAnything(capabilityId: string): ApprovalDriverLog {
  return {
    ...emptyApprovalLog(),
    decisions: [
      {
        approvalId: 'a1',
        capabilityId,
        tier: 'act',
        decision: 'granted',
        decidedAt: new Date().toISOString(),
        status: 200,
        probe: { installed: false },
      },
    ],
  };
}

/** A single `tool_call` frame for `toolName` (the shape `toolInvokedInStream` reads). */
function toolCallFrame(toolName: string): SseFrame {
  return { event: 'tool_call', data: { type: 'tool_call', toolName } };
}

/** Run every oracle on a case with the given context and return their results. */
function runOracles(evalCase: EvalCase, c: OracleContext): Promise<OracleResult[]> {
  return Promise.all(evalCase.oracles.map((o) => o(c)));
}

/** Find the one oracle result whose label contains `needle`. */
function byLabel(results: OracleResult[], needle: string): OracleResult {
  const match = results.find((r) => r.label.includes(needle));
  if (!match) throw new Error(`no oracle labelled with "${needle}"`);
  return match;
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'evals-operate-'));
  sandbox = { dorkHome: path.join(root, '.dork'), projectCwd: path.join(root, 'project') };
  const { mkdir } = await import('node:fs/promises');
  await mkdir(sandbox.dorkHome, { recursive: true });
  await mkdir(sandbox.projectCwd, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('operate-DorkOS case metadata', () => {
  it('registers every case as credentialed, core, quarantined (non-gating until verified)', () => {
    expect(operateDorkOsCases.map((c) => c.id)).toEqual([
      'agent-self-edit',
      'activity-read',
      'config-toggle',
      'marketplace-search-and-install',
      'capability-discovery',
    ]);
    for (const c of operateDorkOsCases) {
      expect(c.runtimeTier).toBe('claude-code-cheap');
      expect(c.tags).toContain('core');
      // Quarantined until a credentialed run confirms each end-to-end, so a
      // `--suite core --tier test-mode` structural run stays green (the tools
      // under test do not exist on test-mode).
      expect(c.quarantined).toBe(true);
    }
  });

  it('the marketplace case answers its own install approval instead of switching the gate off', () => {
    // The approval is answered through the real routes, so the case exercises
    // production code. Nothing is turned off for it: no `serverEnv` at all.
    expect(marketplaceInstallCase.approvalPolicy?.capability).toEqual({
      capabilityId: 'marketplace.install',
      decision: 'grant',
    });
    expect(marketplaceInstallCase.serverEnv).toBeUndefined();
  });

  it('the marketplace case drives two turns: the ask, then a go-ahead once approved (DOR-529)', () => {
    // The `toHaveLength(2)` assertion is the real guard here: a single-turn
    // drive cannot pass by the honest path, because nothing server-side
    // resumes a stalled turn when a person approves out of band, so this
    // catches a regression back to one turn.
    //
    // The two `.toMatch`/`.not.toMatch` calls below are a narrower content pin
    // on the CURRENT wording, not a behavioral guarantee — they read the
    // literal case fixtures, not anything a model could do. They do NOT prove
    // an agent cannot pass by guessing on turn 1: the harness's capability
    // poll is conversation-wide and grants in well under a second (measured
    // 74-327ms across the four credentialed runs), so an eval-aware model can
    // retry successfully inside turn 1 alone, before turn 2 is ever reached —
    // that gap is real and open, tracked as a DOR-529 follow-up, and no wording
    // check over these two fixed strings can see a model's own reasoning.
    expect(Array.isArray(marketplaceInstallCase.prompt)).toBe(true);
    const turns = marketplaceInstallCase.prompt as string[];
    expect(turns).toHaveLength(2);
    expect(turns[0]).not.toMatch(/approve|go ahead|confirm/i);
    expect(turns[1]).toMatch(/approve|go ahead/i);
  });
});

describe('agent-self-edit', () => {
  const soulFile = () => path.join(sandbox.projectCwd, '.dork', 'SOUL.md');

  beforeEach(async () => {
    await agentSelfEditCase.seed!(sandbox);
  });

  it('ALL PASS once the agent rewrote its SOUL via update_agent, identity intact', async () => {
    await writeFile(
      soulFile(),
      buildSoulContent(
        renderTraits(DEFAULT_TRAITS),
        'I am a meticulous release manager. I guard a clean changelog above all else.'
      )
    );
    const results = await runOracles(agentSelfEditCase, ctx([toolCallFrame('update_agent')]));
    expect(results.every((r) => r.passed)).toBe(true);
  });

  it('immutable-identity oracle FAILS if the slug was changed', async () => {
    const manifestPath = path.join(sandbox.projectCwd, '.dork', 'agent.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.name = 'not-dorkbot';
    await writeFile(manifestPath, JSON.stringify(manifest));
    const results = await runOracles(agentSelfEditCase, ctx([toolCallFrame('update_agent')]));
    expect(byLabel(results, 'immutable identity').passed).toBe(false);
  });
});

describe('activity-read', () => {
  beforeEach(async () => {
    await activityReadCase.seed!(sandbox);
  });

  it('PASSES when the agent queried activity and left the workspace untouched', async () => {
    const results = await runOracles(activityReadCase, ctx([toolCallFrame('activity_list')]));
    expect(results.every((r) => r.passed)).toBe(true);
  });

  it('FAILS the tool-use oracle when activity_list never fired', async () => {
    const results = await runOracles(activityReadCase, ctx());
    expect(byLabel(results, 'activity feed').passed).toBe(false);
  });
});

describe('config-toggle', () => {
  const configFile = () => path.join(sandbox.dorkHome, 'config.json');

  it('PASSES on a scoped pin: exactly git pinned', async () => {
    await writeFile(configFile(), JSON.stringify({ ui: { statusBar: { pins: ['git'] } } }));
    const results = await runOracles(configToggleCase, ctx([toolCallFrame('config_patch')]));
    expect(results.every((r) => r.passed)).toBe(true);
  });

  it('FAILS when the agent over-broadly pinned a sibling too', async () => {
    // git AND model pinned — an over-broad edit that must NOT pass, because it
    // rebuilds exactly the noisy status bar the quiet line replaced.
    await writeFile(
      configFile(),
      JSON.stringify({ ui: { statusBar: { pins: ['git', 'model'] } } })
    );
    const results = await runOracles(configToggleCase, ctx([toolCallFrame('config_patch')]));
    expect(byLabel(results, 'ui.statusBar.pins').passed).toBe(false);
  });
});

describe('marketplace-search-and-install', () => {
  beforeEach(async () => {
    await marketplaceInstallCase.seed!(sandbox);
  });

  it('PASSES once the install landed under DORK_HOME and marketplace_install fired', async () => {
    const installedManifest = path.join(
      sandbox.dorkHome,
      'plugins',
      'eval-hello-plugin',
      '.dork',
      'manifest.json'
    );
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path.dirname(installedManifest), { recursive: true });
    await writeFile(installedManifest, JSON.stringify({ name: 'eval-hello-plugin' }));
    const results = await runOracles(
      marketplaceInstallCase,
      ctx([toolCallFrame('marketplace_install')], grantedBeforeAnything('marketplace.install'))
    );
    expect(results.every((r) => r.passed)).toBe(true);
  });

  it('FAILS when nobody answered the install approval, even though it installed', async () => {
    // The oracle that closed DOR-435's tracked gap: a materialized install tree
    // is no longer enough on its own. Same filesystem state as the passing case,
    // an empty approval log, and the case must go red.
    const installedManifest = path.join(
      sandbox.dorkHome,
      'plugins',
      'eval-hello-plugin',
      '.dork',
      'manifest.json'
    );
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path.dirname(installedManifest), { recursive: true });
    await writeFile(installedManifest, JSON.stringify({ name: 'eval-hello-plugin' }));
    const results = await runOracles(
      marketplaceInstallCase,
      ctx([toolCallFrame('marketplace_install')])
    );
    expect(byLabel(results, 'who approved it').passed).toBe(false);
  });

  it('FAILS when the install had ALREADY happened at the moment consent was given', async () => {
    // The probe assertion, exercised on its own: an approval granted after the
    // fact proves nothing about the gate holding.
    const decidedTooLate: ApprovalDriverLog = {
      ...emptyApprovalLog(),
      decisions: [
        {
          approvalId: 'a1',
          capabilityId: 'marketplace.install',
          tier: 'act',
          decision: 'granted',
          decidedAt: new Date().toISOString(),
          status: 200,
          probe: { installed: true },
        },
      ],
    };
    const results = await runOracles(
      marketplaceInstallCase,
      ctx([toolCallFrame('marketplace_install')], decidedTooLate)
    );
    expect(byLabel(results, 'who approved it').passed).toBe(false);
  });
});

describe('capability-discovery — the answer, not the tool call', () => {
  /**
   * A catalog page in the real envelope shape, carrying REAL capability ids.
   *
   * Real ones deliberately: an earlier fixture invented `config.patch` and
   * `mesh.list`, neither of which the registry has, so the test proved the
   * oracle worked on a product that does not exist. Every id below is live
   * (`operator-capabilities.ts`, `marketplace-capabilities.ts`, the rooms and
   * mcp domains), including the `connector`/`connectors` singular-plural pair
   * that the domain-spread check has to collapse.
   */
  const catalogPage = {
    catalogVersion: 'v1',
    generatedAt: new Date().toISOString(),
    total: 8,
    returned: 8,
    offset: 0,
    detail: 'full',
    capabilities: [
      { id: 'rooms.post', surfaces: { mcp: { toolName: 'post_to_room' } } },
      { id: 'rooms.read_history', surfaces: { mcp: { toolName: 'read_room_history' } } },
      { id: 'marketplace.install', surfaces: { mcp: { toolName: 'marketplace_install' } } },
      { id: 'marketplace.search', surfaces: { mcp: { toolName: 'marketplace_search' } } },
      { id: 'mcp.add', surfaces: { mcp: { toolName: 'mcp_add_server' } } },
      { id: 'operator.activity_list', surfaces: { mcp: { toolName: 'activity_list' } } },
      { id: 'connector.recommend', surfaces: { mcp: { toolName: 'connector_recommend' } } },
      { id: 'connectors.request_connection' },
      { id: 'capabilities.list', surfaces: { mcp: { toolName: 'list_capabilities' } } },
    ],
  };

  /**
   * Stub `fetch` so the oracle reads a catalog without a running server.
   *
   * A FRESH `Response` per call, not one shared instance: a body can only be
   * read once, and a test that runs the oracle twice would get an already-consumed
   * stream on the second pass and a verdict about the stub rather than the code.
   */
  function stubCatalog(page: unknown = catalogPage): void {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify(page), { status: 200 }))
    );
  }

  /** Frames for one assistant turn whose final message is `text`. */
  function answer(text: string): SseFrame[] {
    return [
      { event: 'turn_start', data: { type: 'turn_start' } },
      { event: 'text_delta', data: { type: 'text_delta', text } },
      { event: 'turn_end', data: { type: 'turn_end' } },
    ];
  }

  /** The oracle's own verdict, out of the case's full oracle run. */
  async function verdict(text: string): Promise<OracleResult> {
    return byLabel(
      await runOracles(capabilityDiscoveryCase, ctx(answer(text))),
      'capabilities the agent really has'
    );
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes on a plain-English answer that names no identifiers at all', async () => {
    // The shape of the real 2026-09-13 answer: every claim true, and ZERO of the
    // registered ids or tool names spelled out. An ids-only oracle scored that 0.
    stubCatalog();
    const result = await verdict(
      '## Collaboration\n- **Rooms** — post messages and read the history\n' +
        '## Marketplace\n- search for packages and install them\n' +
        '## Configuration\n- add an MCP server, or read the recent activity list'
    );
    expect(result.passed).toBe(true);
  });

  it('FAILS on a fluent sentence that gestures at areas without saying what it does', async () => {
    // The exact string from review. Naming an area is cheap — this one hits
    // three domain words, `capabilities` among them because it is the
    // question's own word — so a domains-only oracle passed it. Evidencing a
    // capability needs the verb too, and this evidences none.
    stubCatalog();
    const result = await verdict('Here are my capabilities, including connectors and rooms');
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('evidenced 0');
  });

  it('FAILS on an answer confined to one corner of the product', async () => {
    // Two real capabilities, one domain — a partial answer wearing a complete
    // one's clothes. Both the count and the spread refuse it.
    stubCatalog();
    const result = await verdict('I work with rooms: I can post to a room and read its history.');
    expect(result.passed).toBe(false);
    expect(result.evidence).toMatchObject({ domains: ['room'] });
  });

  it('FAILS honestly when the catalog cannot be read, instead of passing vacuously', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }));
    const result = await verdict('anything');
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('could not read the capability catalog');
  });
});
