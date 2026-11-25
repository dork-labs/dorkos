/**
 * Drift guard + behavior tests for the tokenless config-disclosure allowlist.
 *
 * `config_get` answers with no credential on the login-off external `/mcp`
 * surface, so what it returns has to be a deliberate projection rather than
 * "everything minus a denylist". The guard here is the point of this file: it
 * compares {@link CONFIG_DISCLOSURE} against the leaves of the live
 * {@link UserConfigSchema} in **both** directions, so adding, renaming, or
 * removing a config field fails until someone classifies it. A denylist would
 * pass silently in exactly that case, which is how `mcp.apiKey` once reached this
 * surface.
 *
 * Membership alone is not enough, so there is a third direction: every `expose`
 * verdict must also **resolve to a scalar**, an array of scalars, or an
 * explicitly allowlisted open record. Without that, a verdict on a subtree
 * (`ui.sidebar.groups`, an array of nine-property objects) silently covers whatever
 * anyone adds inside it, which is the `mcp.apiKey` failure mode one level down.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import {
  CONFIG_DISCLOSURE,
  EXPOSED_RECORD_PATHS,
  PRESENCE_FLAG_PATHS,
  classifySchemaLeaves,
  configSchemaLeafPaths,
} from '../config-disclosure.js';
import {
  pathsWithVerdict,
  schemaLeafShapes,
} from './config-disclosure/config-disclosure.fixtures.js';

describe('CONFIG_DISCLOSURE drift guard', () => {
  it('classifies every leaf of UserConfigSchema', () => {
    // Direction A: a newly added config field must not slip onto the tokenless
    // surface unclassified. The failure message names the offenders so the fix is
    // "add a verdict", not "go hunting".
    const unclassified = configSchemaLeafPaths().filter((p) => !(p in CONFIG_DISCLOSURE));
    expect(unclassified).toEqual([]);
  });

  it('classifies nothing that is not a leaf of UserConfigSchema', () => {
    // Direction B: a renamed or removed field must not leave a stale verdict
    // behind, which would silently stop covering the field that replaced it.
    const schemaLeaves = new Set(configSchemaLeafPaths());
    const stale = Object.keys(CONFIG_DISCLOSURE).filter((p) => !schemaLeaves.has(p));
    expect(stale).toEqual([]);
  });

  it('withholds every secret and every credential reference', () => {
    // The classification itself is asserted, not just the projection: this is the
    // list a reviewer reads. Changing any of these to `expose` is a security
    // decision and has to break a test.
    expect(pathsWithVerdict('withhold').sort()).toEqual([
      // Spending policy a person sets in Runs on (ADR 261001-000811).
      'cloud.credits.agents',
      'cloud.credits.defaults',
      'cloud.credits.linkedTo',
      'cloud.credits.offer',
      'cloud.instanceToken',
      'cloud.linkedAccountLabel',
      'cloud.previousLinkProof',
      // Managed remote access (DOR-2086): consent, credential and address.
      'cloud.remote.consentVersion',
      'cloud.remote.credentialId',
      'cloud.remote.credentialRef',
      'cloud.remote.edgeProofHeader',
      'cloud.remote.edgeProofRef',
      'cloud.remote.enrolmentId',
      'cloud.remote.fingerprint',
      'cloud.remote.hosts',
      'cloud.remote.instanceId',
      'connectors.rawMcpServers[].url',
      // Not a secret: absolute paths on this machine that no agent needs (DOR-2383).
      'extensions.approvedPermissions',
      'extensions.approvedSources',
      'extensions.dismissedApprovals',
      // The agent a mini app forwards the person's comments to (DOR-3325).
      'extensions.forwardAgents',
      // The old approvals still waiting for their places (DOR-4891).
      'extensions.legacySlotless',
      // The old approvals still waiting for a copy (DOR-3068).
      'extensions.legacyUnsourced',
      // Which rooms a mini app may reply in as the person (DOR-3017).
      'extensions.roomAccess',
      'extensions.trustedSources[].source',
      'extensions.trustedSources[].trustedAt',
      // Not a secret: the part digests behind each folder settings yes (DOR-3068).
      'harness.approvedFolderConfigParts',
      // Not a secret: the commit each repo was last compared against (DOR-3298).
      'harness.repoBaselines',
      'mcp.apiKey',
      // The file whose certificates every connection of the desktop app trusts (DOR-3361).
      'network.extraCaCertsPath',
      // Not a secret: the rules behind each folder allow list yes, which no agent needs (DOR-3039).
      'permissions.approvedFolderAllowRules',
      'providers',
      'runtimes.claudeCode.accounts[].onlyProjects',
      'runtimes.claudeCode.defaultAccountOnlyProjects',
      'runtimes.claudeCode.projectAccounts',
      'runtimes.codex.credentialRef',
      'runtimes.doe.inference.credentialEndpoint',
      'runtimes.doe.inference.credentialRef',
      'runtimes.environment.inherit.claudeCode',
      'runtimes.environment.inherit.codex',
      'runtimes.environment.inherit.doe',
      'runtimes.environment.inherit.opencode',
      'runtimes.environment.pathPrepend',
      'tunnel.auth',
      'tunnel.authtoken',
      'ui.communityNavigation.owners[].destinations[].ref',
      'ui.communityNavigation.owners[].destinations[].roomId',
      'ui.communityNavigation.owners[].destinations[].scrollAnchorEntryId',
      'ui.communityNavigation.owners[].destinations[].threadId',
      'ui.communityNavigation.owners[].installationDestination.path',
      'ui.communityNavigation.owners[].installationDestination.search',
      'ui.communityNavigation.owners[].order',
      'ui.communityNavigation.owners[].ownerKey',
      'ui.communityNavigation.version',
      // The one entry here that is not a secret: `ui.sidebar.sections` is a
      // record of objects, a shape `classifySchemaLeaves` cannot name a path
      // inside, so fail-closed applies. See its comment in CONFIG_DISCLOSURE.
      'ui.sidebar.sections',
    ]);
  });

  it('only flags presence for paths that are actually withheld', () => {
    for (const dotPath of PRESENCE_FLAG_PATHS) {
      expect(CONFIG_DISCLOSURE[dotPath as keyof typeof CONFIG_DISCLOSURE]).toBe('withhold');
    }
  });

  it('resolves every exposed leaf to a scalar, an array of scalars, or an allowlisted record', () => {
    // Direction C, and the reason this file exists a second time: membership in
    // the table says a path was classified, not that the verdict covers a value
    // anybody read. A verdict on a subtree covers every field added inside it
    // forever, which is `mcp.apiKey` one level down. Exposing a shape whose
    // contents the schema does not fully name has to be argued, so it fails here.
    const shapes = schemaLeafShapes();
    const offenders = pathsWithVerdict('expose')
      .map((path) => ({ path, shape: shapes.get(path) }))
      .filter(({ path, shape }) => {
        if (shape === 'scalar' || shape === 'scalar-array') return false;
        return !(shape === 'record' && EXPOSED_RECORD_PATHS.includes(path));
      });
    expect(offenders).toEqual([]);
  });

  it('lists every exposed open record explicitly', () => {
    const shapes = schemaLeafShapes();
    // Forward: nothing sits on the allowlist that is not actually an exposed
    // record, so the list cannot rot into a place stale entries hide.
    for (const path of EXPOSED_RECORD_PATHS) {
      expect(CONFIG_DISCLOSURE[path as keyof typeof CONFIG_DISCLOSURE]).toBe('expose');
      expect(shapes.get(path)).toBe('record');
    }
    // Backward: every exposed record is on it.
    const exposedRecords = pathsWithVerdict('expose').filter((p) => shapes.get(p) === 'record');
    expect(exposedRecords.sort()).toEqual([...EXPOSED_RECORD_PATHS].sort());
  });

  it('descends into array elements rather than stopping at the array', () => {
    const paths = configSchemaLeafPaths();
    // The concrete regression: `ui.sidebar.groups` is an array of nine-property
    // objects. Stopping there is what let a field added to a group inherit the
    // array's verdict.
    expect(paths).not.toContain('ui.sidebar.groups');
    expect(paths).toContain('ui.sidebar.groups[].id');
    expect(paths).toContain('ui.sidebar.groups[].rules.pathPrefix');
  });
});

describe('classifySchemaLeaves', () => {
  // Shapes the live config schema does not contain today. The point of the walk
  // is what it does when one of them arrives, so it is exercised directly.
  const scalar = { type: 'string' } as const;
  const secretObject = {
    type: 'object',
    properties: { host: scalar, secretToken: scalar },
    additionalProperties: false,
  } as const;

  it('reads a nullable scalar as one scalar leaf', () => {
    expect(classifySchemaLeaves({ anyOf: [scalar, { type: 'null' }] }, 'tunnel.domain')).toEqual([
      { path: 'tunnel.domain', shape: 'scalar' },
    ]);
  });

  it('sees through a nullable object branch', () => {
    // The reviewer's first synthetic repro: retyping `tunnel.domain` to a
    // nullable object used to hide `secretToken` from the leaf set entirely.
    expect(
      classifySchemaLeaves({ anyOf: [secretObject, { type: 'null' }] }, 'tunnel.domain')
    ).toEqual([
      { path: 'tunnel.domain.host', shape: 'scalar' },
      { path: 'tunnel.domain.secretToken', shape: 'scalar' },
    ]);
  });

  it('sees into every branch of a union', () => {
    // The second repro: a discriminated union used to read as a single leaf.
    const leaves = classifySchemaLeaves(
      {
        anyOf: [
          { type: 'object', properties: { kind: scalar }, additionalProperties: false },
          {
            type: 'object',
            properties: { kind: scalar, secretKey: scalar },
            additionalProperties: false,
          },
        ],
      },
      'auth'
    );
    expect(leaves).toEqual([
      { path: 'auth.kind', shape: 'scalar' },
      { path: 'auth.secretKey', shape: 'scalar' },
    ]);
  });

  it('marks a path whose union branches disagree unsupported', () => {
    expect(
      classifySchemaLeaves(
        { anyOf: [{ type: 'array', items: scalar }, secretObject] },
        'tunnel.domain'
      )
    ).toContainEqual({ path: 'tunnel.domain', shape: 'unsupported' });
  });

  it('descends into array elements and flags arrays of scalars', () => {
    expect(classifySchemaLeaves({ type: 'array', items: scalar }, 'mesh.scanRoots')).toEqual([
      { path: 'mesh.scanRoots', shape: 'scalar-array' },
    ]);
    expect(
      classifySchemaLeaves({ type: 'array', items: secretObject }, 'ui.sidebar.groups')
    ).toEqual([
      { path: 'ui.sidebar.groups[].host', shape: 'scalar' },
      { path: 'ui.sidebar.groups[].secretToken', shape: 'scalar' },
    ]);
  });

  it('accepts a record of scalars and refuses a record of anything else', () => {
    expect(
      classifySchemaLeaves({ type: 'object', additionalProperties: scalar }, 'providers')
    ).toEqual([{ path: 'providers', shape: 'record' }]);
    expect(
      classifySchemaLeaves({ type: 'object', additionalProperties: secretObject }, 'providers')
    ).toEqual([{ path: 'providers', shape: 'unsupported' }]);
    // `z.record(z.string(), z.unknown())` — an untyped value can hold anything.
    expect(classifySchemaLeaves({ type: 'object', additionalProperties: {} }, 'providers')).toEqual(
      [{ path: 'providers', shape: 'unsupported' }]
    );
  });

  it('refuses shapes it cannot reduce instead of waving them through', () => {
    const unsupported = (node: unknown) => classifySchemaLeaves(node, 'x');
    // Named fields plus an open catchall: the catchall's contents have no path.
    expect(
      unsupported({ type: 'object', properties: { a: scalar }, additionalProperties: scalar })
    ).toEqual([{ path: 'x', shape: 'unsupported' }]);
    expect(unsupported({ $ref: '#/$defs/Thing' })).toEqual([{ path: 'x', shape: 'unsupported' }]);
    expect(unsupported({ allOf: [secretObject] })).toEqual([{ path: 'x', shape: 'unsupported' }]);
    expect(unsupported({ type: 'array', prefixItems: [scalar] })).toEqual([
      { path: 'x', shape: 'unsupported' },
    ]);
    expect(unsupported({ type: 'array' })).toEqual([{ path: 'x', shape: 'unsupported' }]);
    expect(unsupported({})).toEqual([{ path: 'x', shape: 'unsupported' }]);
  });

  it('contributes no leaf for an object that can hold nothing', () => {
    expect(classifySchemaLeaves({ type: 'object', additionalProperties: false }, 'x')).toEqual([]);
  });
});
