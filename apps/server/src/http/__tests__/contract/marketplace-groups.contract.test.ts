/**
 * Contract for the marketplace route groups, which move to Hono together in
 * DOR-2803: package sources (`/api/marketplace/sources`), what is installed
 * (`/installed`), the cache (`/cache`), browsing (`/packages`), acting on one
 * package (`/packages/:name/{preview,install,check-files,keep-files,
 * uninstall,update}`), the all-packages update door (`/updates`), held-back
 * global packages (`/held-back`) and dev links (`/dev-links`). That PR must
 * pass this file unchanged.
 *
 * Installing is code from strangers, so most of this file is the trust
 * surface: who may change the package sources, who may decide a held-back
 * package or unlink a dev link, and the approval protocols an agent's install
 * and uninstall wait on (a card a person answers, a token that is single-use
 * and bound to what it was raised for).
 *
 * Three servers:
 *
 * 1. Login off, nothing added: shapes, validation answers, 404s, HEAD,
 *    trailing slashes, and the refusals a caller earns with headers alone.
 * 2. Login off, driven by hand against a marketplace in a folder on this
 *    computer: a source added, listed, refreshed and removed; a package
 *    browsed, previewed, installed and uninstalled by the person; an agent's
 *    install and uninstall held for a person's approval; a folder linked and
 *    unlinked.
 * 3. Login on: no credential is refused at the gate; an API key may change the
 *    package sources (a person's terminal) but may not decide what a person
 *    decides; the owner's cookie may.
 *
 * No case touches the network: the default sources are never fetched (nothing
 * here lists packages or refreshes while they are configured), and the one
 * marketplace this file reads is a folder under the git-ignored `.temp/` at
 * the repository root.
 */
import { cpSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  BOOT_HOOK_TIMEOUT_MS,
  bootComposedServer,
  checkContractCase,
  contractSuite,
  SERVER_ORIGIN,
  type ComposedServer,
  type ContractCase,
} from './harness.js';

/** The repository root: the composed server's directory boundary. */
const REPO_ROOT = realpathSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..')
);
/** The server package, for the package fixtures shipped with its tests. */
const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../services/marketplace/fixtures'
);
/** Everything this file writes, git-ignored and inside the boundary. */
const WORK = path.join(REPO_ROOT, '.temp', `contract-marketplace-${randomUUID().slice(0, 8)}`);
/** A marketplace in a folder: one agent package and one skill pack. */
const MARKET = path.join(WORK, 'market');
/** A skill pack to link from a folder. */
const LINKABLE = path.join(WORK, 'linkable');
const AGENT_PACKAGE = 'contract-agent';
const OTHER_AGENT_PACKAGE = 'contract-agent-two';
const SKILL_PACK = 'contract-skills';
const LINKED_PACK = 'contract-linked';

/** Write a skill pack named `name` into `dir`, from the shipped fixture. */
function writeSkillPack(dir: string, name: string): void {
  cpSync(path.join(FIXTURES, 'valid-skill-pack'), dir, { recursive: true });
  writeFileSync(
    path.join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name, version: '1.0.0', description: 'A contract skill pack' })
  );
  writeFileSync(
    path.join(dir, '.dork', 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      name,
      version: '1.0.0',
      type: 'skill-pack',
      description: 'A contract skill pack',
      author: 'DorkOS',
      license: 'MIT',
      tags: [],
      layers: ['skills'],
    })
  );
}

mkdirSync(WORK, { recursive: true });
for (const name of [AGENT_PACKAGE, OTHER_AGENT_PACKAGE]) {
  cpSync(path.join(FIXTURES, 'valid-agent'), path.join(MARKET, 'packages', name), {
    recursive: true,
  });
  writeFileSync(
    path.join(MARKET, 'packages', name, '.dork', 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      name,
      version: '1.0.0',
      type: 'agent',
      description: 'A contract agent template',
      author: 'DorkOS',
      license: 'MIT',
      tags: [],
      layers: ['skills', 'tasks', 'agents'],
    })
  );
}
writeSkillPack(path.join(MARKET, 'packages', SKILL_PACK), SKILL_PACK);
writeFileSync(
  path.join(MARKET, 'marketplace.json'),
  JSON.stringify({
    name: 'contract',
    owner: { name: 'contract' },
    plugins: [
      {
        name: AGENT_PACKAGE,
        source: `./packages/${AGENT_PACKAGE}`,
        description: 'A contract agent template',
        version: '1.0.0',
      },
      {
        name: OTHER_AGENT_PACKAGE,
        source: `./packages/${OTHER_AGENT_PACKAGE}`,
        description: 'Another contract agent template',
        version: '1.0.0',
      },
      {
        name: SKILL_PACK,
        source: `./packages/${SKILL_PACK}`,
        description: 'A contract skill pack',
        version: '1.0.0',
      },
    ],
  })
);
writeSkillPack(LINKABLE, LINKED_PACK);
afterAll(() => rmSync(WORK, { recursive: true, force: true }));

const JSON_TYPE = { 'content-type': /^application\/json\b/ };
const NOT_FOUND = { error: 'Not found', code: 'API_NOT_FOUND' };
/** An agent header this machine never minted: the caller is a machine, unverified. */
const AGENT = { 'X-DorkOS-Agent': 'not-a-real-token' };
/** A caller holding an approval token is the requester, never the person. */
const REQUESTER = { 'X-DorkOS-Approval': 'not-a-real-approval' };
const VALIDATION_FAILED = z.object({ error: z.literal('Validation failed') }).loose();
const MALFORMED_JSON = z.object({ code: z.literal('INTERNAL_ERROR') }).loose();
const OUTSIDE_BOUNDARY = { error: 'Access denied: projectPath outside boundary' };
const CLIENT_OUTDATED = z
  .object({ error: z.string(), code: z.literal('client_outdated') })
  .strict();
const SOURCE_LIST = z
  .object({
    sources: z.array(
      z.object({ name: z.string(), source: z.string(), enabled: z.boolean() }).loose()
    ),
  })
  .strict();
const PACKAGE_LIST = z.object({ packages: z.array(z.object({ name: z.string() }).loose()) });
const SOURCE_REFUSAL = (action: 'add' | 'remove') =>
  z
    .object({
      error: z.literal(`Only the person running DorkOS can ${action} a package source`),
      code: z.literal('operator_only_marketplace_source'),
      message: z.string(),
    })
    .strict();
const OPERATOR_ONLY = (error: string) => ({ error, code: 'operator_only' });
const CACHE_STATUS = z
  .object({
    marketplaces: z.number(),
    packages: z.number(),
    totalSizeBytes: z.number(),
    cleanup: z.unknown(),
  })
  .strict();
const APPROVAL_REQUIRED = z
  .object({
    status: z.literal('approval_required'),
    approvalId: z.string(),
    approvalToken: z.string(),
  })
  .loose();
/** A fresh card raised because the token sent could not be honoured, and why. */
const TOKEN_ASKED = (reason: string) => z.object({ reason: z.literal(reason) }).loose();
const REQUIRES_CONFIRMATION = z
  .object({
    status: z.literal('requires_confirmation'),
    confirmationToken: z.string(),
    preview: z.unknown(),
    message: z.string(),
  })
  .strict();
const NOT_INSTALLED = (name: string) => z.object({ error: z.string().includes(name) }).strict();
/** A disclosure that runs nothing, as a held-back decision would carry it. */
const EMPTY_EFFECTS = {
  hooks: [],
  schedules: [],
  mcpServers: [],
  lspServers: [],
  monitors: [],
  executables: [],
  skillTools: [],
};

contractSuite('marketplace groups', [
  // sources
  {
    name: 'GET /api/marketplace/sources lists the configured sources',
    path: '/api/marketplace/sources',
    expect: { status: 200, headers: JSON_TYPE, schema: SOURCE_LIST },
  },
  {
    name: 'GET /api/marketplace/sources/ answers with a trailing slash',
    path: '/api/marketplace/sources/',
    expect: { status: 200, headers: JSON_TYPE, schema: SOURCE_LIST },
  },
  {
    name: 'HEAD /api/marketplace/sources answers the GET’s status with no body',
    method: 'HEAD',
    path: '/api/marketplace/sources',
    expect: { status: 200, headers: JSON_TYPE, body: '' },
  },
  {
    name: 'POST /api/marketplace/sources refuses an agent before reading the body',
    method: 'POST',
    path: '/api/marketplace/sources',
    headers: AGENT,
    expect: { status: 403, headers: JSON_TYPE, schema: SOURCE_REFUSAL('add') },
  },
  {
    name: 'POST /api/marketplace/sources refuses an approval-token holder',
    method: 'POST',
    path: '/api/marketplace/sources',
    headers: REQUESTER,
    body: { name: 'evil', source: 'https://example.com/evil' },
    expect: { status: 403, schema: SOURCE_REFUSAL('add') },
  },
  {
    name: 'POST /api/marketplace/sources refuses an empty body',
    method: 'POST',
    path: '/api/marketplace/sources',
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'POST /api/marketplace/sources refuses malformed JSON as the chain does',
    method: 'POST',
    path: '/api/marketplace/sources',
    headers: { 'content-type': 'application/json' },
    body: '{"name":',
    expect: { status: 500, schema: MALFORMED_JSON },
  },
  {
    name: 'POST /api/marketplace/sources refuses an address git must never see',
    method: 'POST',
    path: '/api/marketplace/sources',
    body: { name: 'evil', source: 'ext::sh -c touch% /tmp/pwned' },
    expect: {
      status: 400,
      body: {
        error:
          "That address isn't one DorkOS can fetch a marketplace from. Use an https:// address " +
          'for a git repository, or a file:// path to a folder on this machine.',
      },
    },
  },
  {
    name: 'DELETE /api/marketplace/sources/:name refuses an agent',
    method: 'DELETE',
    path: '/api/marketplace/sources/personal',
    headers: AGENT,
    expect: { status: 403, schema: SOURCE_REFUSAL('remove') },
  },
  {
    name: 'POST /api/marketplace/sources/:name/refresh answers 404 for an unknown source',
    method: 'POST',
    path: '/api/marketplace/sources/no-such-source/refresh',
    expect: {
      status: 404,
      headers: JSON_TYPE,
      body: { error: "Marketplace source 'no-such-source' not found" },
    },
  },
  {
    name: 'GET /api/marketplace/sources/:name is the /api 404 (there is no single-source read)',
    path: '/api/marketplace/sources/personal',
    expect: { status: 404, body: NOT_FOUND },
  },

  // installed
  {
    name: 'GET /api/marketplace/installed lists nothing installed',
    path: '/api/marketplace/installed',
    expect: { status: 200, headers: JSON_TYPE, body: { packages: [] } },
  },
  {
    name: 'GET /api/marketplace/installed?verify=true lists nothing installed',
    path: '/api/marketplace/installed?verify=true',
    expect: { status: 200, body: { packages: [] } },
  },
  {
    name: 'GET /api/marketplace/installed refuses a repeated projectPath',
    path: '/api/marketplace/installed?projectPath=/a&projectPath=/b',
    expect: { status: 400, body: { error: 'projectPath may be given only once' } },
  },
  {
    name: 'GET /api/marketplace/installed refuses a project outside the boundary',
    path: '/api/marketplace/installed?projectPath=/',
    expect: { status: 403, body: OUTSIDE_BOUNDARY },
  },
  {
    name: 'GET /api/marketplace/installed/:name answers 404 for a package nowhere installed',
    path: '/api/marketplace/installed/nothing-here',
    expect: { status: 404, body: { error: "Installed package 'nothing-here' not found" } },
  },
  {
    name: 'HEAD /api/marketplace/installed/:name answers 404 with no body',
    method: 'HEAD',
    path: '/api/marketplace/installed/nothing-here',
    expect: { status: 404, body: '' },
  },

  // cache
  {
    name: 'GET /api/marketplace/cache reports the cache',
    path: '/api/marketplace/cache',
    expect: { status: 200, headers: JSON_TYPE, schema: CACHE_STATUS },
  },
  {
    name: 'POST /api/marketplace/cache/prune refuses the retired keepLastN',
    method: 'POST',
    path: '/api/marketplace/cache/prune',
    body: { keepLastN: 3 },
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'POST /api/marketplace/cache/prune with no body removes nothing from an empty cache',
    method: 'POST',
    path: '/api/marketplace/cache/prune',
    expect: { status: 200, body: { removed: [], freedBytes: 0 } },
  },

  // packages
  {
    name: 'GET /api/marketplace/packages/:name refuses a repeated marketplace',
    path: '/api/marketplace/packages/anything?marketplace=a&marketplace=b',
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'GET /api/marketplace/packages/:name answers 404 for an unknown marketplace',
    path: '/api/marketplace/packages/anything?marketplace=no-such-market',
    expect: { status: 404, body: { error: "Marketplace 'no-such-market' is not configured" } },
  },

  // package actions
  {
    name: 'POST /api/marketplace/packages/:name/preview refuses an empty body',
    method: 'POST',
    path: '/api/marketplace/packages/anything/preview',
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'POST /api/marketplace/packages/:name/preview refuses a project outside the boundary',
    method: 'POST',
    path: '/api/marketplace/packages/anything/preview',
    body: { projectPath: '/' },
    expect: { status: 403, body: OUTSIDE_BOUNDARY },
  },
  {
    name: 'POST /api/marketplace/packages/:name/install refuses a field of the wrong type',
    method: 'POST',
    path: '/api/marketplace/packages/anything/install',
    body: { force: 'yes' },
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'POST /api/marketplace/packages/:name/install refuses a project outside the boundary',
    method: 'POST',
    path: '/api/marketplace/packages/anything/install',
    body: { projectPath: '/' },
    expect: { status: 403, body: OUTSIDE_BOUNDARY },
  },
  {
    name: 'POST /api/marketplace/packages/:name/install answers 404 for an unknown marketplace',
    method: 'POST',
    path: '/api/marketplace/packages/anything/install',
    body: { marketplace: 'no-such-market' },
    expect: { status: 404, body: { error: "Marketplace 'no-such-market' is not configured" } },
  },
  {
    name: 'POST /api/marketplace/packages/:name/uninstall refuses an encoded climb before any gate',
    method: 'POST',
    path: '/api/marketplace/packages/..%2F..%2Fvictim/uninstall',
    body: {},
    expect: { status: 400, schema: z.object({ error: z.string() }).strict() },
  },
  {
    name: 'POST /api/marketplace/packages/:name/uninstall answers 404 when the person removes nothing',
    method: 'POST',
    path: '/api/marketplace/packages/nothing-here/uninstall',
    body: {},
    expect: { status: 404, schema: NOT_INSTALLED('nothing-here') },
  },
  {
    name: 'POST /api/marketplace/packages/:name/uninstall asks a person when an agent calls',
    method: 'POST',
    path: '/api/marketplace/packages/nothing-here/uninstall',
    headers: AGENT,
    body: {},
    expect: { status: 202, headers: JSON_TYPE, schema: APPROVAL_REQUIRED },
  },
  {
    name: 'POST /api/marketplace/packages/:name/uninstall asks again for a token nobody issued',
    method: 'POST',
    path: '/api/marketplace/packages/nothing-here/uninstall',
    headers: { ...AGENT, ...REQUESTER },
    body: {},
    expect: { status: 202, schema: APPROVAL_REQUIRED.and(TOKEN_ASKED('unknown_token')) },
  },
  {
    name: 'POST /api/marketplace/packages/:name/update answers a retired apply with a sentence',
    method: 'POST',
    path: '/api/marketplace/packages/anything/update',
    body: { apply: true },
    expect: { status: 400, schema: CLIENT_OUTDATED },
  },
  {
    name: 'POST /api/marketplace/packages/:name/update refuses an unknown field',
    method: 'POST',
    path: '/api/marketplace/packages/anything/update',
    body: { force: true },
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'POST /api/marketplace/packages/:name/update answers 404 for a package nowhere installed',
    method: 'POST',
    path: '/api/marketplace/packages/nothing-here/update',
    expect: {
      status: 404,
      schema: z.object({ error: z.string(), packageNames: z.array(z.string()) }).loose(),
    },
  },
  {
    name: 'POST /api/marketplace/packages/:name/check-files answers 404 for a package nowhere installed',
    method: 'POST',
    path: '/api/marketplace/packages/nothing-here/check-files',
    expect: { status: 404, schema: NOT_INSTALLED('nothing-here') },
  },
  {
    name: 'POST /api/marketplace/packages/:name/check-files refuses a project outside the boundary',
    method: 'POST',
    path: '/api/marketplace/packages/nothing-here/check-files',
    body: { projectPath: '/' },
    expect: { status: 403, body: OUTSIDE_BOUNDARY },
  },
  {
    name: 'POST /api/marketplace/packages/:name/keep-files refuses an agent',
    method: 'POST',
    path: '/api/marketplace/packages/nothing-here/keep-files',
    headers: AGENT,
    body: { keepKey: 'k' },
    expect: {
      status: 403,
      body: OPERATOR_ONLY('Only you can keep these files as yours, not an agent.'),
    },
  },
  {
    name: 'POST /api/marketplace/packages/:name/keep-files refuses a person’s body with no key',
    method: 'POST',
    path: '/api/marketplace/packages/nothing-here/keep-files',
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'POST /api/marketplace/packages/:name/keep-files answers 404 for a package nowhere installed',
    method: 'POST',
    path: '/api/marketplace/packages/nothing-here/keep-files',
    body: { keepKey: 'k' },
    expect: { status: 404, schema: NOT_INSTALLED('nothing-here') },
  },
  {
    name: 'GET /api/marketplace/packages/:name/install is the /api 404',
    path: '/api/marketplace/packages/anything/install',
    expect: { status: 404, body: NOT_FOUND },
  },

  // updates
  {
    name: 'GET /api/marketplace/updates checks nothing installed',
    path: '/api/marketplace/updates',
    expect: { status: 200, headers: JSON_TYPE, schema: z.object({}).loose() },
  },
  {
    name: 'GET /api/marketplace/updates refuses a repeated projectPath',
    path: '/api/marketplace/updates?projectPath=/a&projectPath=/b',
    expect: { status: 400, body: { error: 'projectPath may be given only once' } },
  },
  {
    name: 'POST /api/marketplace/updates refuses an empty body',
    method: 'POST',
    path: '/api/marketplace/updates',
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'POST /api/marketplace/updates answers an apply with no targets with a sentence',
    method: 'POST',
    path: '/api/marketplace/updates',
    body: { apply: true },
    expect: { status: 400, schema: CLIENT_OUTDATED },
  },
  {
    name: 'POST /api/marketplace/updates answers 404 for an installation that is not there',
    method: 'POST',
    path: '/api/marketplace/updates',
    body: {
      apply: true,
      targets: [
        {
          installPath: '/nowhere/plugins/nothing-here',
          latestVersion: '1.0.0',
          disclosed: null,
          contentHash: 'abc',
        },
      ],
    },
    expect: { status: 404, schema: z.object({ error: z.string() }).loose() },
  },

  // held back
  {
    name: 'GET /api/marketplace/held-back lists nothing held back',
    path: '/api/marketplace/held-back',
    expect: { status: 200, headers: JSON_TYPE, body: { packages: [] } },
  },
  {
    name: 'POST /api/marketplace/held-back/:name/review answers 409 for a package not held back',
    method: 'POST',
    path: '/api/marketplace/held-back/nothing-here/review',
    expect: {
      status: 409,
      schema: z.object({ error: z.string(), code: z.literal('not_reviewable') }).strict(),
    },
  },
  {
    name: 'POST /api/marketplace/held-back/:name/decision refuses an agent',
    method: 'POST',
    path: '/api/marketplace/held-back/nothing-here/decision',
    headers: AGENT,
    body: { decision: 'allow', effects: EMPTY_EFFECTS, bindsTo: 'x' },
    expect: {
      status: 403,
      body: OPERATOR_ONLY('Only you can decide whether a held-back package runs, not an agent.'),
    },
  },
  {
    name: 'POST /api/marketplace/held-back/:name/decision refuses an approval-token holder',
    method: 'POST',
    path: '/api/marketplace/held-back/nothing-here/decision',
    headers: REQUESTER,
    body: { decision: 'allow', effects: EMPTY_EFFECTS, bindsTo: 'x' },
    expect: {
      status: 403,
      body: OPERATOR_ONLY('Only you can decide whether a held-back package runs, not an agent.'),
    },
  },
  {
    name: 'POST /api/marketplace/held-back/:name/decision refuses a person’s empty body',
    method: 'POST',
    path: '/api/marketplace/held-back/nothing-here/decision',
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'POST /api/marketplace/held-back/:name/decision answers 409 for a package not held back',
    method: 'POST',
    path: '/api/marketplace/held-back/nothing-here/decision',
    body: { decision: 'refuse', effects: EMPTY_EFFECTS, bindsTo: 'x' },
    expect: {
      status: 409,
      schema: z.object({ error: z.string(), code: z.literal('not_decidable') }).strict(),
    },
  },

  // dev links
  {
    name: 'GET /api/marketplace/dev-links lists no links',
    path: '/api/marketplace/dev-links',
    expect: { status: 200, headers: JSON_TYPE, schema: z.object({}).loose() },
  },
  {
    name: 'POST /api/marketplace/dev-links/preview refuses an empty body',
    method: 'POST',
    path: '/api/marketplace/dev-links/preview',
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'POST /api/marketplace/dev-links/preview refuses a project link with no project',
    method: 'POST',
    path: '/api/marketplace/dev-links/preview',
    body: { path: LINKABLE, scope: 'project' },
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'POST /api/marketplace/dev-links/preview refuses a project outside the boundary',
    method: 'POST',
    path: '/api/marketplace/dev-links/preview',
    body: { path: LINKABLE, scope: 'project', projectPath: '/' },
    expect: { status: 403, body: OUTSIDE_BOUNDARY },
  },
  {
    name: 'POST /api/marketplace/dev-links refuses an unknown field',
    method: 'POST',
    path: '/api/marketplace/dev-links',
    body: { path: LINKABLE, scope: 'global', force: true },
    expect: { status: 400, schema: VALIDATION_FAILED },
  },
  {
    name: 'POST /api/marketplace/dev-links/:name/unlink refuses an agent',
    method: 'POST',
    path: `/api/marketplace/dev-links/${LINKED_PACK}/unlink`,
    headers: AGENT,
    body: { scope: 'global' },
    expect: { status: 403, body: OPERATOR_ONLY('Only you can unlink a dev link, not an agent.') },
  },
  {
    name: 'POST /api/marketplace/dev-links/:name/unlink refuses a name that is not a package name',
    method: 'POST',
    path: '/api/marketplace/dev-links/Not%20A%20Name/unlink',
    body: { scope: 'global' },
    expect: { status: 400, body: { error: 'That is not a package name.' } },
  },
  {
    name: 'POST /api/marketplace/dev-links/:name/unlink refuses a person’s empty body',
    method: 'POST',
    path: `/api/marketplace/dev-links/${LINKED_PACK}/unlink`,
    expect: { status: 400, schema: VALIDATION_FAILED },
  },

  // the group's own edges
  {
    name: 'GET /api/marketplace is the /api 404 (the group has no root)',
    path: '/api/marketplace',
    expect: { status: 404, body: NOT_FOUND },
  },
  {
    name: 'GET /api/marketplace/nowhere is the /api 404',
    path: '/api/marketplace/nowhere',
    expect: { status: 404, body: NOT_FOUND },
  },

  // the chain in front of every group
  {
    name: 'GET /api/marketplace/sources refuses a foreign Host',
    path: '/api/marketplace/sources',
    headers: { host: 'evil.example.com' },
    expect: { status: 403, schema: z.object({ error: z.string() }).loose() },
  },
  {
    name: 'GET /api/marketplace/installed answers a same-origin browser with its CORS headers',
    path: '/api/marketplace/installed',
    headers: { origin: SERVER_ORIGIN },
    expect: {
      status: 200,
      headers: {
        'access-control-allow-origin': SERVER_ORIGIN,
        'access-control-allow-credentials': 'true',
        vary: /Origin/,
      },
    },
  },
]);

/** A request against a hand-driven server, with the case fields that vary. */
type Ask = Omit<ContractCase, 'name'>;

/** Send one case to the server this file booted itself. */
async function check(server: ComposedServer | undefined, ask: Ask): Promise<void> {
  await checkContractCase(server!.baseUrl, { name: ask.path, ...ask });
}

/** One answer: its status, JSON body (or `{}`) and headers. */
interface Answer {
  status: number;
  json: Record<string, unknown>;
  headers: Headers;
}

/** Send one request and return what it answered, whatever the status. */
async function call(
  server: ComposedServer | undefined,
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<Answer> {
  const res = await fetch(new URL(url, server!.baseUrl), {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return {
    status: res.status,
    json: text ? (JSON.parse(text) as Record<string, unknown>) : {},
    headers: res.headers,
  };
}

/** Send one setup request, failing loudly when the server refuses it. */
async function setup(
  server: ComposedServer | undefined,
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<Answer> {
  const answer = await call(server, method, url, body, headers);
  if (answer.status >= 300) {
    throw new Error(`${method} ${url} answered ${answer.status}: ${JSON.stringify(answer.json)}`);
  }
  return answer;
}

/**
 * Remove every source but the personal one, so nothing this file does reaches
 * a marketplace on the network.
 */
async function keepOnlyLocalSources(
  server: ComposedServer | undefined,
  headers: Record<string, string> = {}
): Promise<void> {
  const listed = await setup(server, 'GET', '/api/marketplace/sources', undefined, headers);
  for (const source of listed.json.sources as { name: string }[]) {
    if (source.name === 'personal') continue;
    await setup(
      server,
      'DELETE',
      `/api/marketplace/sources/${encodeURIComponent(source.name)}`,
      undefined,
      headers
    );
  }
}

/**
 * A person grants a pending approval card: the one named, or the only one
 * pending when none is.
 */
async function grantCard(server: ComposedServer | undefined, approvalId?: string): Promise<void> {
  let id = approvalId;
  if (id === undefined) {
    const pending = await setup(server, 'GET', '/api/approvals/pending');
    const cards = pending.json.approvals as { approvalId: string }[];
    expect(cards).toHaveLength(1);
    id = cards[0]!.approvalId;
  }
  await setup(server, 'POST', `/api/approvals/${id}/grant`, {});
}

describe('contract: the marketplace groups, driven by hand (login off)', () => {
  let server: ComposedServer | undefined;
  beforeAll(async () => {
    server = await bootComposedServer();
    await keepOnlyLocalSources(server);
  }, BOOT_HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await server?.close();
  }, 30_000);

  it('adds a source from a folder, lists it, refreshes it, browses it and removes it', async () => {
    const created = await call(server, 'POST', '/api/marketplace/sources', {
      name: 'contract',
      source: pathToFileURL(MARKET).href,
    });
    expect(created.status).toBe(201);
    expect(created.headers.get('content-type')).toMatch(/^application\/json\b/);
    expect(created.json).toMatchObject({
      name: 'contract',
      source: pathToFileURL(MARKET).href,
      enabled: true,
      listing: { fetched: true, packageCount: 3 },
    });

    const again = await call(server, 'POST', '/api/marketplace/sources', {
      name: 'contract',
      source: pathToFileURL(MARKET).href,
    });
    expect(again.status).toBe(409);
    expect(again.json).toEqual({ error: expect.stringContaining('already exists') });

    await check(server, {
      path: '/api/marketplace/sources',
      expect: {
        status: 200,
        schema: SOURCE_LIST.refine((body) => body.sources.some((s) => s.name === 'contract')),
      },
    });
    const refreshed = await call(server, 'POST', '/api/marketplace/sources/contract/refresh');
    expect(refreshed.status).toBe(200);

    const browsed = await call(server, 'GET', '/api/marketplace/packages');
    expect(browsed.status).toBe(200);
    expect(PACKAGE_LIST.parse(browsed.json).packages.map((p) => p.name)).toEqual(
      expect.arrayContaining([AGENT_PACKAGE, SKILL_PACK])
    );
    const one = await call(
      server,
      'GET',
      `/api/marketplace/packages/${SKILL_PACK}?marketplace=contract`
    );
    expect(one.status).toBe(200);
    expect(one.json).toMatchObject({
      manifest: { name: SKILL_PACK, type: 'skill-pack' },
      contentHash: expect.any(String),
    });
    await check(server, {
      path: `/api/marketplace/packages/not-listed?marketplace=contract`,
      expect: { status: 404, schema: z.object({ error: z.string() }).strict() },
    });

    await check(server, {
      method: 'DELETE',
      path: '/api/marketplace/sources/scratch-never-added',
      expect: { status: 204, body: '' },
    });
  });

  it('lets the person preview, install, check and uninstall a package', async () => {
    const preview = await call(server, 'POST', `/api/marketplace/packages/${SKILL_PACK}/preview`, {
      marketplace: 'contract',
    });
    expect(preview.status).toBe(200);
    expect(preview.json).toMatchObject({
      manifest: { name: SKILL_PACK },
      contentHash: expect.any(String),
    });

    const installed = await call(
      server,
      'POST',
      `/api/marketplace/packages/${SKILL_PACK}/install`,
      {
        marketplace: 'contract',
        approvedDisclosure: preview.json.disclosed,
        approvedContentHash: preview.json.contentHash,
      }
    );
    expect(installed.status).toBe(200);
    expect(installed.json).toMatchObject({ packageName: SKILL_PACK, type: 'skill-pack' });

    const listed = await call(server, 'GET', '/api/marketplace/installed');
    expect(listed.status).toBe(200);
    expect(PACKAGE_LIST.parse(listed.json).packages.map((p) => p.name)).toContain(SKILL_PACK);
    const one = await call(server, 'GET', `/api/marketplace/installed/${SKILL_PACK}`);
    expect(one.status).toBe(200);
    expect(one.json).toMatchObject({ installations: [{ name: SKILL_PACK }] });

    const checked = await call(server, 'POST', `/api/marketplace/packages/${SKILL_PACK}/update`);
    expect(checked.status).toBe(200);
    const updates = await call(server, 'GET', '/api/marketplace/updates');
    expect(updates.status).toBe(200);

    const removed = await call(
      server,
      'POST',
      `/api/marketplace/packages/${SKILL_PACK}/uninstall`,
      {}
    );
    expect(removed.status).toBe(200);
    expect(removed.json).toMatchObject({ packageName: SKILL_PACK });
    await check(server, {
      path: `/api/marketplace/installed/${SKILL_PACK}`,
      expect: { status: 404 },
    });
  });

  it('holds an agent’s install of an agent package until a person approves it, once', async () => {
    const asked = await call(
      server,
      'POST',
      `/api/marketplace/packages/${AGENT_PACKAGE}/install`,
      { marketplace: 'contract' },
      AGENT
    );
    expect(asked.status).toBe(202);
    const pending = REQUIRES_CONFIRMATION.parse(asked.json);

    // Before a person answers, the token installs nothing.
    const early = await call(
      server,
      'POST',
      `/api/marketplace/packages/${AGENT_PACKAGE}/install`,
      { marketplace: 'contract', confirmationToken: pending.confirmationToken },
      AGENT
    );
    expect(early.status).toBe(202);
    expect(REQUIRES_CONFIRMATION.parse(early.json).confirmationToken).toBe(
      pending.confirmationToken
    );

    await grantCard(server);

    // The token is bound to its package: it installs nothing else.
    const elsewhere = await call(
      server,
      'POST',
      `/api/marketplace/packages/${OTHER_AGENT_PACKAGE}/install`,
      { marketplace: 'contract', confirmationToken: pending.confirmationToken },
      AGENT
    );
    expect(elsewhere.status).toBe(202);
    const reasked = REQUIRES_CONFIRMATION.parse(elsewhere.json);
    expect(reasked.confirmationToken).not.toBe(pending.confirmationToken);
    expect(reasked.message).toMatch(/^That approval does not cover this install/);

    const done = await call(
      server,
      'POST',
      `/api/marketplace/packages/${AGENT_PACKAGE}/install`,
      { marketplace: 'contract', confirmationToken: pending.confirmationToken },
      AGENT
    );
    expect(done.status).toBe(200);
    expect(done.json).toMatchObject({ packageName: AGENT_PACKAGE, type: 'agent' });

    // Single use: the same token does not install a second time.
    const replay = await call(
      server,
      'POST',
      `/api/marketplace/packages/${AGENT_PACKAGE}/install`,
      { marketplace: 'contract', confirmationToken: pending.confirmationToken },
      AGENT
    );
    expect(replay.status).toBe(403);
    expect(replay.json).toEqual({ status: 'declined', reason: 'Unknown or expired token' });
  });

  it('holds an agent’s uninstall for a person, then honours the granted token once', async () => {
    const preview = await setup(server, 'POST', `/api/marketplace/packages/${SKILL_PACK}/preview`, {
      marketplace: 'contract',
    });
    await setup(server, 'POST', `/api/marketplace/packages/${SKILL_PACK}/install`, {
      marketplace: 'contract',
      approvedDisclosure: preview.json.disclosed,
      approvedContentHash: preview.json.contentHash,
    });

    const asked = await call(
      server,
      'POST',
      `/api/marketplace/packages/${SKILL_PACK}/uninstall`,
      {},
      AGENT
    );
    expect(asked.status).toBe(202);
    const ticket = APPROVAL_REQUIRED.parse(asked.json);
    await grantCard(server, ticket.approvalId);

    // Bound to its arguments: the token does not remove a different package.
    const elsewhere = await call(
      server,
      'POST',
      `/api/marketplace/packages/${AGENT_PACKAGE}/uninstall`,
      {},
      { ...AGENT, 'X-DorkOS-Approval': ticket.approvalToken }
    );
    expect(elsewhere.status).toBe(202);
    expect(TOKEN_ASKED('wrong_action').parse(elsewhere.json)).toBeTruthy();

    const done = await call(
      server,
      'POST',
      `/api/marketplace/packages/${SKILL_PACK}/uninstall`,
      {},
      { ...AGENT, 'X-DorkOS-Approval': ticket.approvalToken }
    );
    expect(done.status).toBe(200);
    expect(done.json).toMatchObject({ packageName: SKILL_PACK });

    const replay = await call(
      server,
      'POST',
      `/api/marketplace/packages/${SKILL_PACK}/uninstall`,
      {},
      { ...AGENT, 'X-DorkOS-Approval': ticket.approvalToken }
    );
    expect(replay.status).toBe(202);
    expect(TOKEN_ASKED('already_used').parse(replay.json)).toBeTruthy();
  });

  it('previews, links, lists and unlinks a folder for the person', async () => {
    // An agent's link waits on a card the gate raises, naming the folder.
    await check(server, {
      method: 'POST',
      path: '/api/marketplace/dev-links',
      headers: AGENT,
      body: { path: LINKABLE, scope: 'global' },
      expect: { status: 202, headers: JSON_TYPE, schema: APPROVAL_REQUIRED },
    });

    const preview = await call(server, 'POST', '/api/marketplace/dev-links/preview', {
      path: LINKABLE,
      scope: 'global',
    });
    expect(preview.status).toBe(200);
    expect(preview.json).toMatchObject({ change: expect.any(String) });

    const linked = await call(server, 'POST', '/api/marketplace/dev-links', {
      path: LINKABLE,
      scope: 'global',
      via: 'terminal',
      expectedChange: preview.json.change,
    });
    expect(linked.status).toBe(201);
    expect(linked.headers.get('content-type')).toMatch(/^application\/json\b/);

    const listed = await call(server, 'GET', '/api/marketplace/dev-links');
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.json)).toContain(LINKED_PACK);

    // A second link of the same package is refused by its own sentence.
    const again = await call(
      server,
      'POST',
      '/api/marketplace/dev-links',
      { path: LINKABLE, scope: 'global', replaceInstalled: true },
      AGENT
    );
    expect(again.status).toBe(409);
    expect(again.json).toEqual({
      code: 'dev_link_exists',
      error: `${LINKED_PACK} already runs from a dev link here. Unlink it first.`,
      name: LINKED_PACK,
    });

    const unlinked = await call(
      server,
      'POST',
      `/api/marketplace/dev-links/${LINKED_PACK}/unlink`,
      { scope: 'global' }
    );
    expect(unlinked.status).toBe(200);
  });

  it('clears the cache, last, since every install above read its listing from it', async () => {
    await check(server, {
      method: 'DELETE',
      path: '/api/marketplace/cache',
      expect: { status: 204, body: '' },
    });
    await check(server, {
      path: '/api/marketplace/cache',
      expect: { status: 200, schema: CACHE_STATUS },
    });
  });
});

describe('contract: the marketplace groups with login on', () => {
  let server: ComposedServer | undefined;
  let cookie: Record<string, string>;
  let apiKey: Record<string, string>;
  const OWNER = {
    email: `owner-${randomUUID().slice(0, 8)}@dork.test`,
    password: 'a-long-password-1',
  };

  beforeAll(async () => {
    server = await bootComposedServer();
    await keepOnlyLocalSources(server);
    const origin = { origin: server.baseUrl };
    await setup(server, 'POST', '/api/auth/sign-up/email', { ...OWNER, name: 'Owner' }, origin);
    await setup(server, 'PATCH', '/api/config', { auth: { enabled: true } });
    const signedIn = await setup(server, 'POST', '/api/auth/sign-in/email', OWNER, origin);
    cookie = {
      cookie: signedIn.headers
        .getSetCookie()
        .map((value) => value.split(';')[0]!)
        .join('; '),
    };
    const created = await setup(
      server,
      'POST',
      '/api/auth/api-key/create',
      { name: 'c' },
      { ...cookie, ...origin }
    );
    apiKey = { authorization: `Bearer ${created.json.key as string}` };
  }, BOOT_HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await server?.close();
  }, 30_000);

  const AUTH_REQUIRED = z.object({ code: z.literal('AUTH_REQUIRED') }).loose();
  const COOKIE_REQUIRED = z.object({ code: z.literal('operator_cookie_required') }).loose();

  it('refuses a caller with no credential at the session gate', async () => {
    for (const [method, url] of [
      ['GET', '/api/marketplace/sources'],
      ['POST', '/api/marketplace/sources'],
      ['GET', '/api/marketplace/installed'],
      ['POST', '/api/marketplace/packages/anything/install'],
      ['POST', '/api/marketplace/held-back/anything/decision'],
      ['GET', '/api/marketplace/dev-links'],
    ] as const) {
      await check(server, { method, path: url, expect: { status: 401, schema: AUTH_REQUIRED } });
    }
  });

  it('lets an API key change the package sources, as a person’s terminal does', async () => {
    const added = await call(
      server,
      'POST',
      '/api/marketplace/sources',
      { name: 'contract', source: pathToFileURL(MARKET).href },
      apiKey
    );
    expect(added.status).toBe(201);
    await check(server, {
      method: 'DELETE',
      path: '/api/marketplace/sources/contract',
      headers: { ...apiKey, ...AGENT },
      expect: { status: 403, schema: SOURCE_REFUSAL('remove') },
    });
    const removed = await call(
      server,
      'DELETE',
      '/api/marketplace/sources/contract',
      undefined,
      apiKey
    );
    expect(removed.status).toBe(204);
  });

  it('refuses an API key what only a signed-in person decides; the owner’s cookie may', async () => {
    const decision = { decision: 'refuse', effects: EMPTY_EFFECTS, bindsTo: 'x' };
    for (const [url, body] of [
      ['/api/marketplace/held-back/nothing-here/decision', decision],
      ['/api/marketplace/packages/nothing-here/keep-files', { keepKey: 'k' }],
      [`/api/marketplace/dev-links/${LINKED_PACK}/unlink`, { scope: 'global' }],
    ] as const) {
      await check(server, {
        method: 'POST',
        path: url,
        headers: apiKey,
        body,
        expect: { status: 403, schema: COOKIE_REQUIRED },
      });
    }
    await check(server, {
      method: 'POST',
      path: '/api/marketplace/held-back/nothing-here/decision',
      headers: { ...cookie, origin: server!.baseUrl },
      body: decision,
      expect: { status: 409, schema: z.object({ code: z.literal('not_decidable') }).loose() },
    });
    await check(server, {
      method: 'POST',
      path: '/api/marketplace/packages/nothing-here/keep-files',
      headers: { ...cookie, origin: server!.baseUrl },
      body: { keepKey: 'k' },
      expect: { status: 404, schema: NOT_INSTALLED('nothing-here') },
    });
  });

  it('asks a person before an API key uninstalls; the owner’s cookie is not asked', async () => {
    await check(server, {
      method: 'POST',
      path: '/api/marketplace/packages/nothing-here/uninstall',
      headers: apiKey,
      body: {},
      expect: { status: 202, schema: APPROVAL_REQUIRED },
    });
    await check(server, {
      method: 'POST',
      path: '/api/marketplace/packages/nothing-here/uninstall',
      headers: { ...cookie, origin: server!.baseUrl },
      body: {},
      expect: { status: 404, schema: NOT_INSTALLED('nothing-here') },
    });
  });
});
