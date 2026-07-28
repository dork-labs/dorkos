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
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
    // A single-turn drive cannot pass by the honest path: nothing server-side
    // resumes a stalled turn when a person approves out of band, so an agent
    // that correctly stops to ask on turn 1 can never complete the install
    // without a follow-up telling it to proceed. Turn 1 must stay the
    // original, unqualified ask — an agent that assumes approval there is
    // guessing, not being told — and turn 2 is the only place the case says
    // go ahead.
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
