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
import { createDb, activityEvents } from '@dorkos/db';
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
import { selectSuite } from '../index.js';
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

  it('every case declares an approvalPolicy naming only the tools its own task needs', () => {
    // A credentialed turn that reaches for a tool is asked for permission, and a
    // case with nobody to answer sits out the 90-second turn guard and reports a
    // runner error — which is exactly what `agent-self-edit`, `activity-read`
    // and `config-toggle` did on 2026-09-12, the only three `core` cases with no
    // policy. `runner/approval-driver.ts`'s watcher now fails that fast; these
    // policies are what keep it quiet.
    const expected: Record<string, string[]> = {
      'agent-self-edit': ['update_agent'],
      'activity-read': ['activity_list'],
      'config-toggle': ['config_get', 'config_patch'],
      'marketplace-search-and-install': ['marketplace_search', 'marketplace_install'],
      'capability-discovery': ['list_capabilities'],
    };
    for (const c of operateDorkOsCases) {
      expect(c.approvalPolicy?.allowTools, c.id).toEqual(expected[c.id]);
      // Deny-by-default is the point: nothing here allows a file tool or `Bash`,
      // which is how an agent that gave up on the right tool would satisfy a
      // filesystem oracle for the wrong reason.
      expect(c.approvalPolicy?.allowTools.some((t) => /^(bash|write|edit|read)$/i.test(t))).toBe(
        false
      );
    }
  });

  it('are selected by the core suite', () => {
    const coreIds = selectSuite('core').map((c) => c.id);
    for (const c of operateDorkOsCases) {
      expect(coreIds).toContain(c.id);
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

  it('the marketplace case allows only the two tools its task needs', () => {
    // Deny-by-default is what stops an agent that gave up on the MCP tool and
    // hand-built the package tree from making the filesystem oracle green.
    expect(marketplaceInstallCase.approvalPolicy?.allowTools).toEqual([
      'marketplace_search',
      'marketplace_install',
    ]);
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

  it('seeds a system DorkBot agent (immutable identity + default SOUL with markers)', async () => {
    const manifest = JSON.parse(
      await readFile(path.join(sandbox.projectCwd, '.dork', 'agent.json'), 'utf8')
    );
    expect(manifest.name).toBe('dorkbot');
    expect(manifest.isSystem).toBe(true);
    const soul = await readFile(soulFile(), 'utf8');
    expect(soul).toContain('<!-- TRAITS:START -->');
    expect(soul).toContain('<!-- TRAITS:END -->');
  });

  it('FAILS on the untouched scaffold (no tool call, persona not rewritten)', async () => {
    const results = await runOracles(agentSelfEditCase, ctx());
    expect(byLabel(results, 'update_agent').passed).toBe(false);
    expect(byLabel(results, 'was rewritten').passed).toBe(false);
    // Markers + immutable identity are already correct in the scaffold.
    expect(byLabel(results, 'trait markers').passed).toBe(true);
    expect(byLabel(results, 'immutable identity').passed).toBe(true);
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

  it('seeds activity events into dork.db the server will open', async () => {
    const db = createDb(path.join(sandbox.dorkHome, 'dork.db'));
    const rows = await db.select().from(activityEvents);
    db.$client.close();
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.category).sort()).toEqual(['agent', 'config', 'tasks']);
  });

  it('PASSES when the agent queried activity and left the workspace untouched', async () => {
    const results = await runOracles(activityReadCase, ctx([toolCallFrame('activity_list')]));
    expect(results.every((r) => r.passed)).toBe(true);
  });

  it('FAILS the tool-use oracle when activity_list never fired', async () => {
    const results = await runOracles(activityReadCase, ctx());
    expect(byLabel(results, 'activity feed').passed).toBe(false);
  });

  it('FAILS the read-only oracle when the summary wrote into the workspace', async () => {
    await writeFile(path.join(sandbox.projectCwd, 'notes.md'), '# jotted something');
    const results = await runOracles(activityReadCase, ctx([toolCallFrame('activity_list')]));
    expect(byLabel(results, 'read-only').passed).toBe(false);
  });
});

describe('config-toggle', () => {
  const configFile = () => path.join(sandbox.dorkHome, 'config.json');

  it('PASSES on a scoped pin: exactly git pinned', async () => {
    await writeFile(configFile(), JSON.stringify({ ui: { statusBar: { pins: ['git'] } } }));
    const results = await runOracles(configToggleCase, ctx([toolCallFrame('config_patch')]));
    expect(results.every((r) => r.passed)).toBe(true);
  });

  it('FAILS when nothing was pinned', async () => {
    await writeFile(configFile(), JSON.stringify({ ui: { statusBar: { pins: [] } } }));
    const results = await runOracles(configToggleCase, ctx([toolCallFrame('config_patch')]));
    expect(byLabel(results, 'ui.statusBar.pins').passed).toBe(false);
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

  it('FAILS when the section is missing entirely', async () => {
    await writeFile(configFile(), JSON.stringify({ ui: {} }));
    const results = await runOracles(configToggleCase, ctx([toolCallFrame('config_patch')]));
    expect(byLabel(results, 'ui.statusBar.pins').passed).toBe(false);
  });

  it('FAILS the tool-use oracle when config_patch never fired', async () => {
    await writeFile(configFile(), JSON.stringify({ ui: { statusBar: { pins: ['git'] } } }));
    const results = await runOracles(configToggleCase, ctx());
    expect(byLabel(results, 'config_patch').passed).toBe(false);
  });
});

describe('marketplace-search-and-install', () => {
  beforeEach(async () => {
    await marketplaceInstallCase.seed!(sandbox);
  });

  it('seeds an offline file:// marketplace with a relative-path package', async () => {
    const marketplace = JSON.parse(
      await readFile(
        path.join(sandbox.dorkHome, 'eval-fixtures', 'local-marketplace', 'marketplace.json'),
        'utf8'
      )
    );
    expect(marketplace.plugins[0].source).toBe('./eval-hello-plugin');
    // The sources file registers the fixture and suppresses the HTTPS defaults.
    const sources = JSON.parse(
      await readFile(path.join(sandbox.dorkHome, 'marketplaces.json'), 'utf8')
    );
    expect(sources.sources).toHaveLength(1);
    expect(sources.sources[0].source).toContain('file://');
    // The package tree is materially valid (both required manifests present).
    const plugin = JSON.parse(
      await readFile(
        path.join(
          sandbox.dorkHome,
          'eval-fixtures',
          'local-marketplace',
          'eval-hello-plugin',
          '.claude-plugin',
          'plugin.json'
        ),
        'utf8'
      )
    );
    expect(plugin.name).toBe('eval-hello-plugin');
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

  it('FAILS when nothing was installed', async () => {
    const results = await runOracles(
      marketplaceInstallCase,
      ctx([toolCallFrame('marketplace_install')])
    );
    expect(byLabel(results, 'installed under DORK_HOME').passed).toBe(false);
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

  it('passes on an answer that DOES spell the tool names', async () => {
    stubCatalog();
    expect(
      (
        await verdict(
          'I can use post_to_room, marketplace_install, marketplace_search, mcp_add_server, ' +
            'activity_list and list_capabilities.'
        )
      ).passed
    ).toBe(true);
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

  it('FAILS that same sentence even when it also name-drops the UI', async () => {
    stubCatalog();
    expect(
      (await verdict('Here are my capabilities in the UI, with connectors and rooms')).passed
    ).toBe(false);
  });

  it('FAILS on a vague answer that describes nothing', async () => {
    stubCatalog();
    const result = await verdict('I can help you with all sorts of things — just ask!');
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

  it('counts a singular/plural domain pair in the registry as ONE area', async () => {
    // `connector` and `connectors` are both real domains. The word "connectors"
    // must not buy two-thirds of the domain-spread bar on its own.
    stubCatalog();
    const result = await verdict(
      'I can recommend connectors and request a connection through them.'
    );
    expect(result.evidence).toMatchObject({ domains: ['connector'] });
  });

  it('FAILS honestly when the catalog cannot be read, instead of passing vacuously', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }));
    const result = await verdict('anything');
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('could not read the capability catalog');
  });

  it('matches a word at both boundaries, not anywhere inside a longer one', async () => {
    // `ui` must match "UI" and not "build"/"guide", or every answer covers it.
    stubCatalog({ ...catalogPage, capabilities: [{ id: 'ui.click' }] });
    expect(
      (await verdict('I can build things and guide you, clicking as I go.')).evidence
    ).toMatchObject({ evidenced: [] });
    expect((await verdict('I can click things in the UI for you.')).evidence).toMatchObject({
      evidenced: ['ui.click'],
    });
  });

  it('records whether the catalog tool was called, as evidence and not as a verdict', async () => {
    // Since #1080 an agent is taught its tools by name and may answer without
    // calling `list_capabilities`. That is no longer a failure — but it stays
    // visible on the transcript.
    stubCatalog();
    const words = answer(
      'Rooms: post messages, read the history. Marketplace: search and install. ' +
        'Also add an MCP server.'
    );
    const without = await runOracles(capabilityDiscoveryCase, ctx(words));
    expect(byLabel(without, 'capabilities the agent really has').passed).toBe(true);
    expect(byLabel(without, 'capabilities the agent really has').evidence).toMatchObject({
      calledListCapabilities: false,
    });

    const withCall = await runOracles(
      capabilityDiscoveryCase,
      ctx([toolCallFrame('mcp__dorkos__list_capabilities'), ...words])
    );
    expect(byLabel(withCall, 'capabilities the agent really has').evidence).toMatchObject({
      calledListCapabilities: true,
    });
  });
});
