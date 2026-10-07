/**
 * Holds what DorkOS sends and reads to the committed protocol snapshot
 * (spec `codex-app-server-transport` §16, the typo guard).
 *
 * The server silently drops an unknown param (spike 1c), so a misspelt key or
 * a wrong enum literal would fail nowhere at runtime. Every outbound params
 * schema in `schemas.ts` is checked key by key against the binary's own
 * schema, a full sample of each is checked strictly, every enum literal DorkOS
 * sends is checked against the binary's enum, and the method unions in
 * `methods.ts` must equal the snapshot's.
 */
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CLIENT_REQUEST_METHODS,
  SERVER_NOTIFICATION_METHODS,
  SERVER_REQUEST_METHODS,
  PINNED_CODEX_APP_SERVER_VERSION,
  THREAD_ITEM_TYPES,
  refusalFor,
} from '../protocol/methods.js';
import {
  AskForApprovalSchema,
  NOTIFICATION_SCHEMAS,
  OUTBOUND_PARAMS,
  SandboxModeSchema,
} from '../protocol/schemas.js';
import {
  PROTOCOL_SNAPSHOT_FILE,
  diffProtocolSnapshots,
  type ProtocolSnapshot,
} from '../protocol/snapshot.js';
import { schemaErrors } from './json-schema-check.js';

const snapshot = JSON.parse(fs.readFileSync(PROTOCOL_SNAPSHOT_FILE, 'utf8')) as ProtocolSnapshot;
const defs = snapshot.definitions as Record<string, unknown>;

/** A full sample of every request DorkOS sends: every key its schema allows. */
const SAMPLES: Record<(typeof CLIENT_REQUEST_METHODS)[number], unknown> = {
  initialize: {
    clientInfo: { name: 'dorkos', title: 'DorkOS', version: '1.0.0' },
    capabilities: { experimentalApi: true },
  },
  'model/list': { cursor: null, includeHidden: false, limit: 100 },
  'config/read': { cwd: '/project' },
  'account/rateLimits/read': null,
  'thread/start': {
    cwd: '/project',
    model: 'gpt-x',
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    sandbox: 'workspace-write',
    config: { mcp_servers: {} },
  },
  'thread/resume': {
    threadId: 't',
    cwd: '/project',
    model: 'gpt-x',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandbox: 'read-only',
    config: {},
  },
  'turn/start': {
    threadId: 't',
    input: [{ type: 'text', text: 'hi', text_elements: [] }],
    clientUserMessageId: 'm1',
    cwd: '/project',
    approvalPolicy: 'never',
    sandboxPolicy: {
      type: 'workspaceWrite',
      writableRoots: ['/grant'],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
    model: 'gpt-x',
    effort: 'high',
    summary: 'auto',
  },
  'turn/steer': {
    threadId: 't',
    expectedTurnId: 'u',
    input: [{ type: 'text', text: 'also this', text_elements: [] }],
    clientUserMessageId: 'm2',
  },
  'turn/interrupt': { threadId: 't', turnId: 'u' },
  'thread/backgroundTerminals/list': { threadId: 't' },
  'thread/backgroundTerminals/terminate': { threadId: 't', processId: '4242' },
  'thread/read': { threadId: 't', includeTurns: true },
  'thread/fork': {
    threadId: 't',
    cwd: '/project',
    model: 'gpt-x',
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    sandbox: 'read-only',
    config: {},
  },
  'thread/unsubscribe': { threadId: 't' },
  'thread/compact/start': { threadId: 't' },
};

/** The object keys a zod schema names, recursively, as dotted paths. */
function zodKeyPaths(schema: z.ZodType, prefix = ''): string[] {
  const def = (schema as unknown as { def: { type: string } }).def;
  if (def.type === 'optional' || def.type === 'nullable') {
    return zodKeyPaths((def as unknown as { innerType: z.ZodType }).innerType, prefix);
  }
  if (def.type !== 'object') return [];
  const shape = (schema as unknown as { shape: Record<string, z.ZodType> }).shape;
  return Object.entries(shape).flatMap(([key, child]) => {
    const here = prefix ? `${prefix}.${key}` : key;
    return [here, ...zodKeyPaths(child, here)];
  });
}

/** Resolve a dotted key path to its property schema in the snapshot, or `undefined`. */
function snapshotProperty(root: unknown, keyPath: string): unknown {
  let node: unknown = root;
  for (const key of keyPath.split('.')) {
    node = propertiesOf(node)?.[key];
    if (node === undefined) return undefined;
  }
  return node;
}

function propertiesOf(node: unknown): Record<string, unknown> | undefined {
  const s = node as Record<string, unknown> | undefined;
  if (!s) return undefined;
  if (typeof s.$ref === 'string') return propertiesOf(defs[s.$ref.replace('#/definitions/', '')]);
  if (s.properties) return s.properties as Record<string, unknown>;
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    for (const branch of (s[key] as unknown[] | undefined) ?? []) {
      const found = propertiesOf(branch);
      if (found) return found;
    }
  }
  return undefined;
}

describe('outbound params against the binary’s schema', () => {
  it.each(CLIENT_REQUEST_METHODS)(
    'every key DorkOS can send on %s exists in the snapshot',
    (method) => {
      const schema = OUTBOUND_PARAMS[method];
      const params = snapshot.clientRequests[method]?.params;
      expect(params, `${method} is missing from the snapshot`).toBeDefined();
      if (schema === null) return;
      const missing = zodKeyPaths(schema).filter(
        // `config` is a free-form map by design; its keys are Codex config keys.
        (key) => !key.startsWith('config.') && snapshotProperty(params, key) === undefined
      );
      expect(missing).toEqual([]);
    }
  );

  it.each(CLIENT_REQUEST_METHODS)(
    'a full %s sample parses locally and conforms strictly',
    (method) => {
      const sample = SAMPLES[method];
      const schema = OUTBOUND_PARAMS[method];
      if (schema !== null) schema.parse(sample);
      if (sample === null) return;
      expect(schemaErrors(sample, snapshot.clientRequests[method]!.params, defs)).toEqual([]);
    }
  );

  it('every sandbox, approval and sandbox-policy literal DorkOS sends is in the binary’s enums', () => {
    for (const mode of SandboxModeSchema.options) {
      expect(schemaErrors(mode, { $ref: '#/definitions/SandboxMode' }, defs)).toEqual([]);
    }
    for (const policy of AskForApprovalSchema.options) {
      expect(schemaErrors(policy, { $ref: '#/definitions/AskForApproval' }, defs)).toEqual([]);
    }
    for (const policy of [
      { type: 'dangerFullAccess' },
      { type: 'readOnly', networkAccess: false },
    ]) {
      expect(schemaErrors(policy, { $ref: '#/definitions/SandboxPolicy' }, defs)).toEqual([]);
    }
    expect(schemaErrors('user', { $ref: '#/definitions/ApprovalsReviewer' }, defs)).toEqual([]);
  });

  it('catches the typo it exists for', () => {
    // The proof the check is not vacuous: the camelCase spelling the stale
    // upstream README used is refused, as is an invented key.
    const turn = snapshot.clientRequests['turn/start']!.params;
    expect(
      schemaErrors({ ...(SAMPLES['turn/start'] as object), sandbox: 'workspaceWrite' }, turn, defs)
    ).not.toEqual([]);
    expect(
      schemaErrors(SAMPLES['thread/start'], snapshot.clientRequests['thread/start']!.params, defs)
    ).toEqual([]);
    expect(
      schemaErrors(
        { ...(SAMPLES['thread/start'] as object), sandbox: 'workspaceWrite' },
        snapshot.clientRequests['thread/start']!.params,
        defs
      )
    ).not.toEqual([]);
  });
});

describe('inbound shapes and unions', () => {
  it('pins the version the snapshot was taken from', () => {
    expect(PINNED_CODEX_APP_SERVER_VERSION).toBe(snapshot.binaryVersion);
  });

  it('the method and item unions in methods.ts equal the binary’s', () => {
    expect([...SERVER_NOTIFICATION_METHODS]).toEqual(snapshot.unions.serverNotificationMethods);
    expect([...SERVER_REQUEST_METHODS]).toEqual(snapshot.unions.serverRequestMethods);
    expect([...THREAD_ITEM_TYPES]).toEqual(snapshot.unions.threadItemTypes);
  });

  it.each(Object.keys(NOTIFICATION_SCHEMAS))('every field DorkOS reads on %s exists', (method) => {
    const params = snapshot.serverNotifications[method]?.params;
    expect(params, `${method} is missing from the snapshot`).toBeDefined();
    const schema = NOTIFICATION_SCHEMAS[method as keyof typeof NOTIFICATION_SCHEMAS]!;
    const missing = zodKeyPaths(schema).filter(
      (key) => snapshotProperty(params, key) === undefined
    );
    expect(missing).toEqual([]);
  });

  it.each(SERVER_REQUEST_METHODS)(
    'the reply DorkOS sends to %s conforms to its result schema',
    (method) => {
      const refusal = refusalFor(method);
      if (refusal === null) {
        // Answered with a JSON-RPC error instead: nothing to conform.
        expect([
          'account/chatgptAuthTokens/refresh',
          'attestation/generate',
          'currentTime/read',
        ]).toContain(method);
        return;
      }
      expect(schemaErrors(refusal, snapshot.serverRequests[method]!.result, defs)).toEqual([]);
    }
  );

  it('no refusal accepts anything', () => {
    const replies = SERVER_REQUEST_METHODS.map((method) => JSON.stringify(refusalFor(method)));
    for (const reply of replies) expect(reply).not.toMatch(/"accept|approved|"session"/);
  });
});

describe('snapshot diffing', () => {
  it('names the method and the field that drifted', () => {
    const drifted = structuredClone(snapshot) as unknown as {
      definitions: Record<string, { properties: Record<string, unknown> }>;
    };
    delete drifted.definitions.TurnInterruptParams!.properties.turnId;
    const diff = diffProtocolSnapshots(snapshot, drifted);
    expect(diff).toHaveLength(1);
    expect(diff[0]).toContain('$.definitions.TurnInterruptParams.properties.turnId: removed');
    expect(diff[0]).toContain('turn/interrupt');
    expect(diffProtocolSnapshots(snapshot, structuredClone(snapshot))).toEqual([]);
  });
});
