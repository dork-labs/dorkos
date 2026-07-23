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
import type { EvalCase, EvalSandbox, OracleContext, OracleResult } from '../../types.js';
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

/** An OracleContext over the seeded sandbox with an optional transcript. */
function ctx(frames: SseFrame[] = []): OracleContext {
  return { sandbox, baseUrl: 'http://unused', sessionId: 's', frames };
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
  it('registers all four cases as credentialed, core, quarantined (non-gating until verified)', () => {
    expect(operateDorkOsCases.map((c) => c.id)).toEqual([
      'agent-self-edit',
      'activity-read',
      'config-toggle',
      'marketplace-search-and-install',
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

  it('the marketplace case auto-approves installs on the credentialed server', () => {
    expect(marketplaceInstallCase.serverEnv).toEqual({ MARKETPLACE_AUTO_APPROVE: '1' });
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

  it('PASSES on a scoped flip: only git false, a sibling present at its default', async () => {
    // git hidden, model still explicitly visible (present + default) — the
    // scoped edit the eval measures.
    await writeFile(
      configFile(),
      JSON.stringify({ ui: { statusBar: { git: false, model: true } } })
    );
    const results = await runOracles(configToggleCase, ctx([toolCallFrame('config_patch')]));
    expect(results.every((r) => r.passed)).toBe(true);
  });

  it('PASSES when only git materializes (absent siblings resolve to their default)', async () => {
    await writeFile(configFile(), JSON.stringify({ ui: { statusBar: { git: false } } }));
    const results = await runOracles(configToggleCase, ctx([toolCallFrame('config_patch')]));
    expect(results.every((r) => r.passed)).toBe(true);
  });

  it('FAILS when the git item is still visible (not flipped)', async () => {
    await writeFile(configFile(), JSON.stringify({ ui: { statusBar: { git: true } } }));
    const results = await runOracles(configToggleCase, ctx([toolCallFrame('config_patch')]));
    expect(byLabel(results, 'ui.statusBar.git').passed).toBe(false);
  });

  it('FAILS when the agent over-broadly flipped a sibling too (whole bar off)', async () => {
    // git AND model both hidden — an over-broad edit that must NOT pass.
    await writeFile(
      configFile(),
      JSON.stringify({ ui: { statusBar: { git: false, model: false } } })
    );
    const results = await runOracles(configToggleCase, ctx([toolCallFrame('config_patch')]));
    expect(byLabel(results, 'ui.statusBar.git').passed).toBe(false);
  });

  it('FAILS the tool-use oracle when config_patch never fired', async () => {
    await writeFile(configFile(), JSON.stringify({ ui: { statusBar: { git: false } } }));
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
      ctx([toolCallFrame('marketplace_install')])
    );
    expect(results.every((r) => r.passed)).toBe(true);
  });

  it('FAILS when nothing was installed', async () => {
    const results = await runOracles(
      marketplaceInstallCase,
      ctx([toolCallFrame('marketplace_install')])
    );
    expect(byLabel(results, 'installed under DORK_HOME').passed).toBe(false);
  });
});
