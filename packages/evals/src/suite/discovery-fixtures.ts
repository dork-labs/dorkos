/**
 * What the `discovery` cases seed before a turn: an agent with a plain job in
 * the project folder, an offline marketplace holding one fitting package and
 * one unrelated one, and (for the "already have it" case) that fitting package
 * installed. Kept apart from the cases so every case shares one seeding path
 * and one set of case fields.
 *
 * @module evals/suite/discovery-fixtures
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { writeManifest } from '@dorkos/shared/manifest';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { ApprovalPolicy, EvalCase, EvalSandbox } from '../types.js';

/** The job of the agent the connection cases seed: the team says where it talks. */
export const RELEASE_JOB =
  'Helps the Brightline team ship their app: release notes, deploy checks and team updates. ' +
  'The team talks in Slack.';

/** The same job with no word about where the team talks, so a menu is tempting. */
export const RELEASE_JOB_NO_CHAT =
  'Helps the Brightline team ship their app: release notes, deploy checks and team updates.';

/** The job of the agent the shop cases seed. */
export const SHOP_JOB =
  'Helps Lil run her small online shop: email, calendar, files and paperwork.';

/** The package that genuinely fits a repeated changelog task. */
export const FITTING_PACKAGE = 'changelog-writer';

/** The package that has no bearing on booking a meeting. */
export const UNRELATED_PACKAGE = 'css-tidy-lint';

/** The fixture marketplace's slug. */
const FIXTURE_MARKETPLACE = 'discovery-fixture';

/** One package the fixture marketplace lists. */
interface FixturePackage {
  name: string;
  description: string;
  tags: string[];
  /** The one skill it carries, so an installed copy gives the agent something real. */
  skill: { name: string; body: string };
}

/** The packages the fixture marketplace lists, by name. */
export const FIXTURE_PACKAGES: Record<string, FixturePackage> = {
  [FITTING_PACKAGE]: {
    name: FITTING_PACKAGE,
    description:
      'Writes changelog entries and release notes from a fix or a commit, in one plain, ' +
      'consistent voice, so every entry reads the same.',
    tags: ['changelog', 'release-notes', 'writing'],
    skill: {
      name: 'writing-changelog-entries',
      body:
        '---\nname: writing-changelog-entries\ndescription: Write one changelog entry for a fix.\n---\n\n' +
        'Write one bullet under "### Fixed": what the person can now do, in plain words, ' +
        'no file names.\n',
    },
  },
  [UNRELATED_PACKAGE]: {
    name: UNRELATED_PACKAGE,
    // "order" is shared with case 8's prompt on purpose: the keyword scorer behind
    // `marketplace_recommend` then really offers this package for "book a
    // meeting … the Q4 order", which is the over-match the case is about.
    description:
      'Lints and tidies CSS files and Tailwind class lists: puts rules in a consistent order ' +
      'and flags unused selectors.',
    tags: ['css', 'lint', 'stylesheet', 'tailwind'],
    skill: {
      name: 'tidying-css',
      body: '---\nname: tidying-css\ndescription: Tidy a CSS file.\n---\n\nSort the rules.\n',
    },
  },
};

/**
 * Write an agent manifest into the project folder, so the turn has an agent
 * identity and a job ("would clearly make this task go better" needs a task).
 *
 * @param sandbox - The eval sandbox.
 * @param name - The agent's slug.
 * @param description - Its job, in one line.
 */
export async function writeDiscoveryAgent(
  sandbox: EvalSandbox,
  name: string,
  description: string
): Promise<void> {
  const manifest: AgentManifest = {
    workspace: { mode: 'home' },
    id: `01JQXYZEVALDISCOV${name
      .toUpperCase()
      .replace(/[^A-Z]/g, '')
      .padEnd(9, '0')
      .slice(0, 9)}`,
    name,
    displayName: name.charAt(0).toUpperCase() + name.slice(1),
    description,
    runtime: 'claude-code',
    capabilities: [],
    behavior: { responseMode: 'always' },
    registeredAt: new Date().toISOString(),
    registeredBy: 'dorkos-evals',
    personaEnabled: true,
    mcpServers: [],
  };
  await writeManifest(sandbox.projectCwd, manifest);
}

/** Write one JSON file, pretty, creating its folder. */
async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

/** Write one package tree (plugin.json, the DorkOS manifest and its skill) at `dir`. */
async function writePackageTree(dir: string, pkg: FixturePackage): Promise<void> {
  const meta = { name: pkg.name, version: '1.0.0', description: pkg.description };
  await writeJson(path.join(dir, '.claude-plugin', 'plugin.json'), meta);
  await writeJson(path.join(dir, '.dork', 'manifest.json'), {
    schemaVersion: 1,
    ...meta,
    type: 'plugin',
    tags: pkg.tags,
    layers: [],
    requires: [],
    extensions: [],
  });
  const skillFile = path.join(dir, 'skills', pkg.skill.name, 'SKILL.md');
  await mkdir(path.dirname(skillFile), { recursive: true });
  await writeFile(skillFile, pkg.skill.body, 'utf8');
}

/**
 * Seed a fully offline local marketplace listing `names`: a `file://` source in
 * `${dorkHome}/marketplaces.json` (which also keeps the production sources out,
 * since those are seeded only when the file is absent), and each package as a
 * relative-path plugin beside its `marketplace.json`. The same shape as the
 * `marketplace-search-and-install` case's fixture (`suite/operate.ts`). With
 * no names it writes `sources: []`, so the case has no marketplace at all and
 * no lookup can reach the network.
 *
 * @param sandbox - The eval sandbox.
 * @param names - Which of {@link FIXTURE_PACKAGES} to list.
 */
export async function seedMarketplace(
  sandbox: EvalSandbox,
  names: readonly string[]
): Promise<void> {
  if (names.length === 0) {
    await writeJson(path.join(sandbox.dorkHome, 'marketplaces.json'), { version: 1, sources: [] });
    return;
  }
  const root = path.join(sandbox.dorkHome, 'eval-fixtures', 'discovery-marketplace');
  const listed = names.map((name) => FIXTURE_PACKAGES[name]!);
  for (const pkg of listed) await writePackageTree(path.join(root, pkg.name), pkg);
  await writeJson(path.join(root, 'marketplace.json'), {
    name: FIXTURE_MARKETPLACE,
    owner: { name: 'DorkOS Eval Harness' },
    metadata: { description: 'Offline discovery eval marketplace' },
    plugins: listed.map((pkg) => ({
      name: pkg.name,
      source: `./${pkg.name}`,
      description: pkg.description,
      tags: pkg.tags,
    })),
  });
  await writeJson(path.join(sandbox.dorkHome, 'marketplaces.json'), {
    version: 1,
    sources: [
      {
        name: FIXTURE_MARKETPLACE,
        source: `file://${root}`,
        enabled: true,
        addedAt: '2026-10-12T00:00:00.000Z',
      },
    ],
  });
}

/**
 * Install a fixture package globally, the way the install pipeline leaves one:
 * its tree under `${dorkHome}/plugins/<name>/`, which `marketplace_list_installed`
 * lists and which the Claude Code runtime loads as a plugin (it runs nothing on
 * its own, so no consent is owed), so its skill is really there.
 *
 * @param sandbox - The eval sandbox.
 * @param name - Which of {@link FIXTURE_PACKAGES} to install.
 */
export async function seedInstalledPackage(sandbox: EvalSandbox, name: string): Promise<void> {
  await writePackageTree(path.join(sandbox.dorkHome, 'plugins', name), FIXTURE_PACKAGES[name]!);
}

/**
 * A seed that writes the agent, then the marketplace, then any installed
 * package, then `files` (relative path to contents) into the project folder.
 *
 * @param opts - What to seed.
 * @returns A seed for {@link EvalCase.seed}.
 */
export function seedDiscovery(opts: {
  job: string;
  marketplace?: readonly string[];
  installed?: readonly string[];
  files?: Record<string, string>;
}): (sandbox: EvalSandbox) => Promise<void> {
  return async (sandbox) => {
    await writeDiscoveryAgent(sandbox, 'assistant', opts.job);
    // Always written: with no file, the server seeds the public marketplaces,
    // and a case would then reach the live network (as governance.ts does).
    await seedMarketplace(sandbox, opts.marketplace ?? []);
    for (const name of opts.installed ?? []) await seedInstalledPackage(sandbox, name);
    for (const [relative, content] of Object.entries(opts.files ?? {})) {
      const target = path.join(sandbox.projectCwd, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, 'utf8');
    }
  };
}

/**
 * The fields every `discovery` case shares, fresh per case so no two share a
 * `tags` array. Credentialed, quarantined, never `core`.
 */
export function discoveryCommon(): Pick<
  EvalCase,
  'runtimeTier' | 'costClass' | 'tags' | 'quarantined' | 'perEvalCeilingUsd'
> {
  return {
    runtimeTier: 'claude-code-cheap',
    costClass: 'cheap',
    tags: ['discovery'],
    quarantined: true,
    perEvalCeilingUsd: 0.5,
  };
}

/**
 * The tools a discovery turn may use: reading, and every way of looking up or
 * asking for a connection or a package. Installing is NOT here: a turn that
 * tries to install is denied, because the person decides that, not the agent.
 */
export const DISCOVERY_TOOLS = [
  'Read',
  'connector_recommend',
  'connector_list_toolkits',
  'connectors.request_connection',
  'connectors.get_connection_request',
  'connectors.list_granted_connections',
  'connectors.list_granted_operations',
  'marketplace_recommend',
  'marketplace_search',
  'marketplace_get',
  'marketplace_list_installed',
  'marketplace_list_marketplaces',
];

/** The one line every question card in a `discovery` turn is answered with. */
export const QUESTION_ANSWER = 'Use your best judgment.';

/**
 * The policy every session-shaped `discovery` case carries. A connection
 * request is answered with the owner's "no" through the owner route, so a held
 * request can never park the turn (`runner/interaction-answers.ts`); a question
 * card gets one fixed line.
 */
export const DISCOVERY_POLICY: ApprovalPolicy = {
  allowTools: DISCOVERY_TOOLS,
  connectionRequests: 'deny',
  answerQuestions: QUESTION_ANSWER,
};

/** The file the "nothing would help" case asks to have summarised. */
export const NOTES_FILE = 'meeting-notes.md';

/** Its contents: everything the summary needs is here, so nothing outside helps. */
export const NOTES_CONTENT =
  '# Ops sync, 9 October\n\n' +
  '- Launch moves to Friday, because the payment page needs one more test pass.\n' +
  '- Ana owns the price list update; due Wednesday.\n' +
  '- Ben will reorder blue glaze; the supplier needs two weeks.\n' +
  '- Next sync is Thursday at 10.\n';
