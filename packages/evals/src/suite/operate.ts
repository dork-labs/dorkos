/**
 * The operate-DorkOS suite (DOR-435, spec agents-as-operators §1.7): four
 * outcome-oracle evals proving an agent can OPERATE DorkOS from natural
 * language — edit its own persona, read the activity feed, toggle a setting,
 * and install a package — through the in-session `dorkos` MCP tools landed by
 * the P1 coherence work (operator tools DOR-430, `ui.statusBar` config DOR-431,
 * in-session marketplace tools DOR-429).
 *
 * WHY `claude-code-cheap`, WHY `quarantined`: these are model behavior —
 * choosing and calling the right MCP tool from a plain request — which
 * `test-mode` cannot produce (its runtime exposes no MCP tools, `supportsMcp`
 * false). So each case's real run is on `claude-code-cheap`, where the
 * out-of-process server registers the real in-session tool surface. Until a
 * CREDENTIALED run confirms each case end-to-end, they stay `quarantined`
 * (they run and report but never gate) — the demo-claim gate (AGENTS.md: never
 * claim a still-unverified surface works), the same discipline the
 * `design-your-own-interview` case follows. They carry the `core` tag so the
 * nightly `core` suite runs them on `claude-code-cheap`; drop `quarantined`
 * (per case) once its credentialed run is green.
 *
 * DEGRADE-ON-TEST-MODE: a `--suite core --tier test-mode` structural self-check
 * boots the in-process `test-mode` server for every core case. These four drive
 * their prompt against `TestModeRuntime` (no MCP tools), so their oracles fail —
 * but because they are `quarantined`, that failure never gates the run (see
 * `report/summary.ts` `runGateFailed`). The gate stays green; the cases are
 * exercised structurally.
 *
 * WHAT EACH ORACLE ASSERTS (side effects on the sandbox filesystem / the
 * collected tool stream — never assistant prose):
 * - `agent-self-edit`: the agent used `update_agent`, its seeded `SOUL.md`
 *   persona was rewritten (markers intact), and its immutable identity
 *   (`name`, `isSystem`) is unchanged.
 * - `activity-read`: the agent called `activity_list`, and the read-only
 *   summary mutated nothing in its workspace.
 * - `config-toggle`: the agent used `config_patch` and the `ui.statusBar.git`
 *   flag flipped to `false` in the sandbox `config.json`.
 * - `marketplace-search-and-install`: the agent used `marketplace_install`
 *   and the package tree materialized under the sandbox `DORK_HOME`.
 *
 * SANDBOXING: every case runs in the harness's `mkdtemp` sandbox (a fresh
 * `DORK_HOME` + project cwd, `runner/sandbox.ts`); no case reads or writes the
 * real `~/.dork`. The marketplace case seeds a LOCAL `file://` marketplace
 * fixture on disk with one relative-path package, so the install pipeline is
 * fully offline (no git, no network); the update-checker is never called.
 *
 * @module evals/suite/operate
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { writeManifest } from '@dorkos/shared/manifest';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { writeConventionFile } from '@dorkos/shared/convention-files-io';
import {
  defaultSoulTemplate,
  defaultNopeTemplate,
  extractCustomProse,
  TRAIT_SECTION_START,
  TRAIT_SECTION_END,
} from '@dorkos/shared/convention-files';
import { renderTraits, DEFAULT_TRAITS } from '@dorkos/shared/trait-renderer';
import { createDb, runMigrations, activityEvents } from '@dorkos/db';
import type { EvalCase, EvalSandbox } from '../types.js';
import {
  fileMatches,
  jsonFileMatches,
  fileExists,
  dirContainsOnly,
} from '../oracles/filesystem.js';
import { toolInvokedInStream } from '../oracles/stream.js';

// ─────────────────────────────────────────────────────────────────────────────
// agent-self-edit
// ─────────────────────────────────────────────────────────────────────────────

/** The seeded agent's slug — immutable, so the identity oracle can pin it. */
const SELF_EDIT_AGENT_SLUG = 'dorkbot';

/** Resolve the seeded agent's `SOUL.md` inside the sandbox project cwd. */
const selfEditSoulPath = (sandbox: EvalSandbox): string =>
  path.join(sandbox.projectCwd, '.dork', 'SOUL.md');

/** Resolve the seeded agent's `agent.json` inside the sandbox project cwd. */
const selfEditManifestPath = (sandbox: EvalSandbox): string =>
  path.join(sandbox.projectCwd, '.dork', 'agent.json');

/** The default persona prose a fresh agent is scaffolded with (below the trait block). */
function seededSelfEditProse(): string {
  const traitBlock = renderTraits(DEFAULT_TRAITS);
  return extractCustomProse(defaultSoulTemplate('DorkBot', traitBlock));
}

/**
 * Seed a DorkBot-flavored SYSTEM agent into the sandbox project cwd: a valid
 * `agent.json` (`isSystem: true`, `namespace: 'system'`, the immutable
 * `dorkbot` slug) plus a default `SOUL.md` + `NOPE.md`. The eval then drives the
 * agent to rewrite its own persona; the identity oracle proves the system
 * agent's immutable fields survived that self-edit.
 *
 * @param sandbox - The fresh eval sandbox (its `projectCwd` becomes the agent dir).
 */
async function seedSelfEditAgent(sandbox: EvalSandbox): Promise<void> {
  const traitBlock = renderTraits(DEFAULT_TRAITS);
  const manifest: AgentManifest = {
    id: '01JQXYZDORKBOTSELFEDIT0001',
    name: SELF_EDIT_AGENT_SLUG,
    displayName: 'DorkBot',
    description: 'Your guide to DorkOS.',
    runtime: 'claude-code',
    capabilities: ['tasks', 'summaries'],
    isSystem: true,
    namespace: 'system',
    behavior: { responseMode: 'always' },
    traits: { ...DEFAULT_TRAITS },
    conventions: { soul: true, nope: true, dorkosKnowledge: true },
    registeredAt: new Date().toISOString(),
    registeredBy: 'dorkos-evals',
    personaEnabled: true,
    enabledToolGroups: {},
  };
  await writeManifest(sandbox.projectCwd, manifest);
  await writeConventionFile(
    sandbox.projectCwd,
    'SOUL.md',
    defaultSoulTemplate('DorkBot', traitBlock)
  );
  await writeConventionFile(sandbox.projectCwd, 'NOPE.md', defaultNopeTemplate());
}

/**
 * `agent-self-edit` — the agent rewrites its own persona through the
 * `update_agent` MCP tool, and its immutable identity survives. Asserts on the
 * authored `SOUL.md`, the intact trait markers, the preserved `name`/`isSystem`,
 * and that `update_agent` actually fired.
 */
export const agentSelfEditCase: EvalCase = {
  id: 'agent-self-edit',
  title: 'Agent self-edit — DorkBot rewrites its own persona, immutable identity intact',
  prompt:
    'Please update your own persona. Rewrite your SOUL so you describe yourself as a meticulous ' +
    'release manager who guards a clean changelog, and save the change to yourself using your ' +
    'agent-update tool. Keep working in this project directory.',
  runtimeTier: 'claude-code-cheap',
  costClass: 'cheap',
  tags: ['core'],
  quarantined: true,
  perEvalCeilingUsd: 0.5,
  seed: seedSelfEditAgent,
  oracles: [
    toolInvokedInStream('update_agent', 'the agent used update_agent to edit itself'),
    fileMatches(
      selfEditSoulPath,
      (content) => content.includes(TRAIT_SECTION_START) && content.includes(TRAIT_SECTION_END),
      'SOUL.md keeps its trait markers intact'
    ),
    fileMatches(
      selfEditSoulPath,
      (content) => {
        const prose = extractCustomProse(content);
        return prose.length > 40 && prose.trim() !== seededSelfEditProse().trim();
      },
      'SOUL.md persona prose was rewritten (differs from the default scaffold)'
    ),
    jsonFileMatches(
      selfEditManifestPath,
      (value) => {
        const m = value as { name?: unknown; isSystem?: unknown };
        return m.name === SELF_EDIT_AGENT_SLUG && m.isSystem === true;
      },
      'immutable identity preserved (agent.json name + isSystem unchanged)'
    ),
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// activity-read
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Seed a handful of activity-feed events into the sandbox `dork.db` BEFORE the
 * server boots. Opens the same SQLite file the server will open (a
 * migrate-then-insert; the server's own boot migration is idempotent), inserts
 * three rows across categories, then closes the handle so the server can open
 * it cleanly. Gives the summary something real to read; the oracle only needs
 * the `activity_list` call to have fired.
 *
 * @param sandbox - The fresh eval sandbox (its `dorkHome` holds `dork.db`).
 */
async function seedActivityEvents(sandbox: EvalSandbox): Promise<void> {
  const db = createDb(path.join(sandbox.dorkHome, 'dork.db'));
  runMigrations(db);
  const now = Date.now();
  const rows = [
    {
      category: 'agent' as const,
      actorType: 'agent' as const,
      actorLabel: 'Scribe',
      eventType: 'agent.created',
      summary: 'Scribe was created',
    },
    {
      category: 'tasks' as const,
      actorType: 'tasks' as const,
      actorLabel: 'Tasks',
      eventType: 'tasks.run_success',
      summary: 'daily-digest ran successfully (2m 14s)',
    },
    {
      category: 'config' as const,
      actorType: 'user' as const,
      actorLabel: 'You',
      eventType: 'config.updated',
      summary: 'Status-bar preferences changed',
    },
  ];
  await db.insert(activityEvents).values(
    rows.map((r, i) => ({
      id: randomUUID(),
      // Space the events out so their occurredAt ordering is deterministic.
      occurredAt: new Date(now - (rows.length - i) * 60_000).toISOString(),
      actorType: r.actorType,
      actorId: null,
      actorLabel: r.actorLabel,
      category: r.category,
      eventType: r.eventType,
      resourceType: null,
      resourceId: null,
      resourceLabel: null,
      summary: r.summary,
      linkPath: null,
      metadata: null,
      createdAt: new Date(now).toISOString(),
    }))
  );
  db.$client.close();
}

/**
 * `activity-read` — the agent reads the activity feed and summarizes it, a
 * read-only operation. Asserts `activity_list` fired and that the summary
 * mutated nothing in the workspace (an empty project cwd stays empty).
 */
export const activityReadCase: EvalCase = {
  id: 'activity-read',
  title: 'Activity read — the agent summarizes recent activity and mutates nothing',
  prompt:
    'Give me a short summary of what has happened recently in DorkOS — the recent activity feed. ' +
    'Just read and summarize it; do not change anything.',
  runtimeTier: 'claude-code-cheap',
  costClass: 'cheap',
  tags: ['core'],
  quarantined: true,
  perEvalCeilingUsd: 0.5,
  seed: seedActivityEvents,
  oracles: [
    toolInvokedInStream('activity_list', 'the agent queried the activity feed'),
    dirContainsOnly(
      (sandbox) => sandbox.projectCwd,
      [],
      'read-only: the summary created nothing in the workspace'
    ),
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// config-toggle
// ─────────────────────────────────────────────────────────────────────────────

/** Resolve the sandbox `config.json` (the `conf`-backed user config store). */
const configPath = (sandbox: EvalSandbox): string => path.join(sandbox.dorkHome, 'config.json');

/**
 * `config-toggle` — the user asks (by intent, not by config key) to hide the git
 * status-bar item; the agent discovers the setting and flips it via
 * `config_patch`. Asserts `config_patch` fired and `ui.statusBar.git` is `false`
 * in the sandbox `config.json`. No seed: the item defaults to visible (`true`),
 * so a `false` on disk is an unambiguous flip.
 */
export const configToggleCase: EvalCase = {
  id: 'config-toggle',
  title: 'Config toggle — "hide the git info in my status bar" flips ui.statusBar.git',
  prompt: 'Hide the git info in my status bar — I do not want to see the branch and change count.',
  runtimeTier: 'claude-code-cheap',
  costClass: 'cheap',
  tags: ['core'],
  quarantined: true,
  perEvalCeilingUsd: 0.5,
  oracles: [
    toolInvokedInStream('config_patch', 'the agent used config_patch to change a setting'),
    jsonFileMatches(
      configPath,
      (value) => {
        const ui = (value as { ui?: { statusBar?: { git?: unknown } } }).ui;
        return ui?.statusBar?.git === false;
      },
      'ui.statusBar.git flipped to false in config.json'
    ),
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// marketplace-search-and-install
// ─────────────────────────────────────────────────────────────────────────────

/** The fixture package's slug — kebab-case, not a reserved marketplace name. */
const FIXTURE_PLUGIN_NAME = 'eval-hello-plugin';

/** The fixture marketplace's slug. */
const FIXTURE_MARKETPLACE_NAME = 'eval-fixture';

/** Resolve the offline marketplace fixture root inside the sandbox `DORK_HOME`. */
const fixtureMarketplaceRoot = (sandbox: EvalSandbox): string =>
  path.join(sandbox.dorkHome, 'eval-fixtures', 'local-marketplace');

/** Resolve the installed package tree an oracle stats to prove the install landed (global scope). */
const installedManifestPath = (sandbox: EvalSandbox): string =>
  path.join(sandbox.dorkHome, 'plugins', FIXTURE_PLUGIN_NAME, '.dork', 'manifest.json');

/**
 * Seed a fully-offline local marketplace: a `file://` source registered in
 * `${dorkHome}/marketplaces.json` (which also SUPPRESSES the production HTTPS
 * default sources — those are seeded only when the file is absent) pointing at a
 * `local-marketplace/` on disk whose one plugin uses a RELATIVE-PATH source
 * (`./eval-hello-plugin`). A relative-path package inside a `file://`
 * marketplace installs with no git and no network (the install pipeline
 * materializes the subdir off disk).
 *
 * @param sandbox - The fresh eval sandbox (its `dorkHome` holds the fixture + sources file).
 */
async function seedMarketplaceFixture(sandbox: EvalSandbox): Promise<void> {
  const root = fixtureMarketplaceRoot(sandbox);
  const pkgDir = path.join(root, FIXTURE_PLUGIN_NAME);
  await mkdir(path.join(pkgDir, '.claude-plugin'), { recursive: true });
  await mkdir(path.join(pkgDir, '.dork'), { recursive: true });

  await writeFile(
    path.join(root, 'marketplace.json'),
    JSON.stringify(
      {
        name: FIXTURE_MARKETPLACE_NAME,
        owner: { name: 'DorkOS Eval Harness' },
        metadata: { description: 'Offline eval fixture marketplace' },
        plugins: [
          {
            name: FIXTURE_PLUGIN_NAME,
            source: `./${FIXTURE_PLUGIN_NAME}`,
            description: 'Minimal plugin for the offline install eval',
          },
        ],
      },
      null,
      2
    ) + '\n',
    'utf8'
  );

  await writeFile(
    path.join(pkgDir, '.claude-plugin', 'plugin.json'),
    JSON.stringify(
      {
        name: FIXTURE_PLUGIN_NAME,
        version: '1.0.0',
        description: 'Minimal plugin for the offline install eval',
      },
      null,
      2
    ) + '\n',
    'utf8'
  );

  await writeFile(
    path.join(pkgDir, '.dork', 'manifest.json'),
    JSON.stringify(
      {
        schemaVersion: 1,
        name: FIXTURE_PLUGIN_NAME,
        version: '1.0.0',
        type: 'plugin',
        description: 'Minimal plugin for the offline install eval',
        tags: [],
        layers: [],
        requires: [],
        extensions: [],
      },
      null,
      2
    ) + '\n',
    'utf8'
  );

  await writeFile(
    path.join(sandbox.dorkHome, 'marketplaces.json'),
    JSON.stringify(
      {
        version: 1,
        sources: [
          {
            name: FIXTURE_MARKETPLACE_NAME,
            source: `file://${root}`,
            enabled: true,
            addedAt: '2026-07-22T00:00:00.000Z',
          },
        ],
      },
      null,
      2
    ) + '\n',
    'utf8'
  );
}

/**
 * `marketplace-search-and-install` — the agent finds the fixture package and
 * installs it. Asserts `marketplace_install` fired and the package tree
 * materialized under the sandbox `DORK_HOME`. Sets `MARKETPLACE_AUTO_APPROVE=1`
 * on the credentialed server so the headless agent's install completes without
 * the out-of-band human approval POST the interactive confirmation-token flow
 * otherwise requires — the confirmation provider is still exercised, just
 * auto-approved.
 */
export const marketplaceInstallCase: EvalCase = {
  id: 'marketplace-search-and-install',
  title: 'Marketplace — the agent finds a package and installs it from a local source',
  prompt: `Look in my marketplace for a package called "${FIXTURE_PLUGIN_NAME}", then install it for me.`,
  runtimeTier: 'claude-code-cheap',
  costClass: 'cheap',
  tags: ['core'],
  quarantined: true,
  perEvalCeilingUsd: 0.5,
  serverEnv: { MARKETPLACE_AUTO_APPROVE: '1' },
  seed: seedMarketplaceFixture,
  oracles: [
    toolInvokedInStream('marketplace_install', 'the agent invoked marketplace_install'),
    fileExists(
      installedManifestPath,
      `the ${FIXTURE_PLUGIN_NAME} package tree was installed under DORK_HOME`
    ),
  ],
};

/** Every operate-DorkOS case, in registration order. */
export const operateDorkOsCases: EvalCase[] = [
  agentSelfEditCase,
  activityReadCase,
  configToggleCase,
  marketplaceInstallCase,
];
