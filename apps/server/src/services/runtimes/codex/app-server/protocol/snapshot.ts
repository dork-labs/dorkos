/**
 * Build, serialize and compare the committed `codex app-server` protocol
 * snapshot (spec `codex-app-server-transport` §16).
 *
 * The snapshot holds, for every method, notification and server request DorkOS
 * uses (`methods.ts`), the JSON Schema of its params and result as the pinned
 * binary generates it (`codex app-server generate-json-schema --experimental`),
 * each with the closure of the definitions it references, plus the full lists
 * of notification methods, server request methods and thread item types, and
 * the binary's version. Keys are sorted, so the same binary always produces
 * the same bytes.
 *
 * Used by `scripts/codex-protocol-snapshot.ts` (regenerate) and
 * `protocol-snapshot.binary.test.ts` (fail on drift).
 *
 * @module services/runtimes/codex/app-server/protocol/snapshot
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CLIENT_NOTIFICATION_METHODS,
  CLIENT_REQUEST_METHODS,
  SERVER_REQUEST_METHODS,
} from './methods.js';
import { NOTIFICATION_SCHEMAS } from './schemas.js';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

/** One schema: `{ "$ref": "#/definitions/<root>" }` or an inline schema. */
export type SnapshotSchema = Json;

/** The committed snapshot. */
export interface ProtocolSnapshot {
  /** `codex --version` of the binary that generated it, e.g. `0.154.0`. */
  binaryVersion: string;
  /** Every definition any schema below reaches, once, by name. */
  definitions: JsonObject;
  /** Requests DorkOS sends. */
  clientRequests: Record<string, { params: SnapshotSchema | null; result: SnapshotSchema }>;
  /** Notifications DorkOS sends. */
  clientNotifications: Record<string, { params: SnapshotSchema | null }>;
  /** Notifications DorkOS reads. */
  serverNotifications: Record<string, { params: SnapshotSchema }>;
  /** Every server request (DorkOS answers each one, if only to refuse). */
  serverRequests: Record<string, { params: SnapshotSchema; result: SnapshotSchema }>;
  /** Complete unions, so an addition fails the schema test. */
  unions: {
    serverNotificationMethods: string[];
    serverRequestMethods: string[];
    threadItemTypes: string[];
  };
}

function readJson(file: string): JsonObject {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as JsonObject;
}

function refName(ref: string): string {
  const prefix = '#/definitions/';
  if (!ref.startsWith(prefix)) throw new Error(`Unexpected $ref ${ref}`);
  return ref.slice(prefix.length);
}

/** Every `$ref` name reachable from `schema` through `definitions`. */
function closureOf(schema: Json, definitions: JsonObject): JsonObject {
  const out: JsonObject = {};
  const visit = (node: Json): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') {
        const name = refName(value);
        if (!(name in out)) {
          const def = definitions[name];
          if (def === undefined) throw new Error(`Missing definition ${name}`);
          out[name] = def;
          visit(def);
        }
      } else {
        visit(value);
      }
    }
  };
  visit(schema);
  return out;
}

/**
 * Record a schema's closure into the shared table and return the schema. Two
 * files naming the same definition differently is a generator change worth
 * failing on, not silently picking one.
 */
function withClosure(schema: Json, definitions: JsonObject, shared: JsonObject): SnapshotSchema {
  for (const [name, def] of Object.entries(closureOf(schema, definitions))) {
    const existing = shared[name];
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(def)) {
      throw new Error(`Definition ${name} differs between generated files`);
    }
    shared[name] = def;
  }
  return schema;
}

/** The `oneOf` variants of a union file, by method. */
function variantsByMethod(file: JsonObject): Map<string, JsonObject> {
  const out = new Map<string, JsonObject>();
  for (const variant of (file.oneOf ?? []) as JsonObject[]) {
    const props = variant.properties as JsonObject;
    const method = ((props.method as JsonObject).enum as string[])[0]!;
    out.set(method, variant);
  }
  return out;
}

/** The params `$ref` name a request variant names (unwrapping `anyOf [ref, null]`). */
function paramsRefName(variant: JsonObject): string | null {
  const params = (variant.properties as JsonObject).params as JsonObject | undefined;
  if (!params) return null;
  if (typeof params.$ref === 'string') return refName(params.$ref);
  const anyOf = params.anyOf as JsonObject[] | undefined;
  const ref = anyOf?.find((entry) => typeof entry.$ref === 'string');
  return ref ? refName(ref.$ref as string) : null;
}

/** Find `<name>.json` in the generated tree (root, `v1/`, `v2/`). */
function findSchemaFile(dir: string, name: string): string {
  for (const sub of ['', 'v1', 'v2']) {
    const file = path.join(dir, sub, `${name}.json`);
    if (fs.existsSync(file)) return file;
  }
  throw new Error(`No generated schema named ${name}`);
}

function resultSchema(dir: string, paramsName: string, shared: JsonObject): SnapshotSchema {
  const base = paramsName.replace(/Params$/, '');
  const file = readJson(findSchemaFile(dir, `${base}Response`));
  const { definitions = {}, ...schema } = file;
  delete (schema as JsonObject).$schema;
  return withClosure(schema as Json, definitions as JsonObject, shared);
}

/**
 * Build the snapshot from a directory `generate-json-schema` wrote.
 *
 * @param dir - The generated schema directory.
 * @param binaryVersion - The generating binary's version.
 */
export function buildProtocolSnapshot(dir: string, binaryVersion: string): ProtocolSnapshot {
  const shared: JsonObject = {};
  const clientRequestFile = readJson(path.join(dir, 'ClientRequest.json'));
  const clientDefs = clientRequestFile.definitions as JsonObject;
  const requests = variantsByMethod(clientRequestFile);
  const clientRequests: ProtocolSnapshot['clientRequests'] = {};
  for (const method of CLIENT_REQUEST_METHODS) {
    const variant = requests.get(method);
    if (!variant) throw new Error(`The binary has no client request ${method}`);
    const name = paramsRefName(variant);
    if (!name) throw new Error(`Client request ${method} names no params type`);
    clientRequests[method] = {
      params: withClosure({ $ref: `#/definitions/${name}` }, clientDefs, shared),
      result: resultSchema(dir, name, shared),
    };
  }

  const clientNotificationFile = readJson(path.join(dir, 'ClientNotification.json'));
  const clientNotes = variantsByMethod(clientNotificationFile);
  const clientNotifications: ProtocolSnapshot['clientNotifications'] = {};
  for (const method of CLIENT_NOTIFICATION_METHODS) {
    const variant = clientNotes.get(method);
    if (!variant) throw new Error(`The binary has no client notification ${method}`);
    const name = paramsRefName(variant);
    clientNotifications[method] = {
      params: name
        ? withClosure(
            { $ref: `#/definitions/${name}` },
            (clientNotificationFile.definitions ?? {}) as JsonObject,
            shared
          )
        : null,
    };
  }

  const notificationFile = readJson(path.join(dir, 'ServerNotification.json'));
  const notificationDefs = notificationFile.definitions as JsonObject;
  const notifications = variantsByMethod(notificationFile);
  const serverNotifications: ProtocolSnapshot['serverNotifications'] = {};
  for (const method of Object.keys(NOTIFICATION_SCHEMAS).sort()) {
    const variant = notifications.get(method);
    if (!variant) throw new Error(`The binary has no notification ${method}`);
    const name = paramsRefName(variant);
    if (!name) throw new Error(`Notification ${method} names no params type`);
    serverNotifications[method] = {
      params: withClosure({ $ref: `#/definitions/${name}` }, notificationDefs, shared),
    };
  }

  const serverRequestFile = readJson(path.join(dir, 'ServerRequest.json'));
  const serverRequestDefs = serverRequestFile.definitions as JsonObject;
  const serverRequestVariants = variantsByMethod(serverRequestFile);
  const serverRequests: ProtocolSnapshot['serverRequests'] = {};
  for (const method of SERVER_REQUEST_METHODS) {
    const variant = serverRequestVariants.get(method);
    if (!variant) throw new Error(`The binary has no server request ${method}`);
    const name = paramsRefName(variant);
    if (!name) throw new Error(`Server request ${method} names no params type`);
    serverRequests[method] = {
      params: withClosure({ $ref: `#/definitions/${name}` }, serverRequestDefs, shared),
      result: resultSchema(dir, name, shared),
    };
  }

  const threadItem = notificationDefs.ThreadItem as JsonObject;
  const threadItemTypes = ((threadItem.oneOf ?? []) as JsonObject[]).map((variant) => {
    const type = (variant.properties as JsonObject | undefined)?.type as JsonObject | undefined;
    const literal = (type?.enum as string[] | undefined)?.[0];
    if (!literal) throw new Error('A ThreadItem variant has no type literal');
    return literal;
  });

  return {
    binaryVersion,
    definitions: shared,
    clientRequests,
    clientNotifications,
    serverNotifications,
    serverRequests,
    unions: {
      serverNotificationMethods: [...notifications.keys()],
      serverRequestMethods: [...serverRequestVariants.keys()],
      threadItemTypes,
    },
  };
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value as object)
      .sort()
      .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])])
  );
}

/**
 * Serialize deterministically: sorted keys, two-space indent, trailing newline.
 *
 * @param snapshot - The snapshot.
 */
export function serializeProtocolSnapshot(snapshot: ProtocolSnapshot): string {
  return `${JSON.stringify(sortKeys(snapshot), null, 2)}\n`;
}

/**
 * Every difference between two snapshots, each naming the method (or section)
 * and the JSON path that differs. Empty when they match.
 *
 * @param committed - The snapshot in the repository.
 * @param regenerated - The one the binary produces now.
 */
export function diffProtocolSnapshots(committed: unknown, regenerated: unknown): string[] {
  const out: string[] = [];
  const walk = (a: unknown, b: unknown, at: string): void => {
    if (out.length >= 50) return;
    if (a === b) return;
    if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') {
      out.push(`${at}: ${JSON.stringify(a)} → ${JSON.stringify(b)}`);
      return;
    }
    if (Array.isArray(a) !== Array.isArray(b)) {
      out.push(`${at}: shape changed`);
      return;
    }
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    for (const key of [...keys].sort()) {
      const left = (a as Record<string, unknown>)[key];
      const right = (b as Record<string, unknown>)[key];
      if (left === undefined) out.push(`${at}.${key}: added`);
      else if (right === undefined) out.push(`${at}.${key}: removed`);
      else walk(left, right, `${at}.${key}`);
    }
  };
  walk(committed, regenerated, '$');
  const users = definitionUsers(regenerated);
  return out.map((line) => {
    const match = /^\$\.definitions\.([^.:]+)/.exec(line);
    const methods = match ? users.get(match[1]!) : undefined;
    return methods && methods.length > 0 ? `${line} (used by ${methods.join(', ')})` : line;
  });
}

/** Which methods reach each definition, so a definition diff names its methods. */
function definitionUsers(snapshot: unknown): Map<string, string[]> {
  const users = new Map<string, string[]>();
  if (snapshot === null || typeof snapshot !== 'object') return users;
  const snap = snapshot as ProtocolSnapshot;
  const definitions = snap.definitions ?? {};
  const sections = [
    snap.clientRequests,
    snap.clientNotifications,
    snap.serverNotifications,
    snap.serverRequests,
  ];
  for (const section of sections) {
    for (const [method, entry] of Object.entries(section ?? {})) {
      let reached: JsonObject;
      try {
        reached = closureOf(entry as unknown as Json, definitions);
      } catch {
        continue;
      }
      for (const name of Object.keys(reached)) {
        users.set(name, [...(users.get(name) ?? []), method]);
      }
    }
  }
  return users;
}

/**
 * Ask a binary for its version (`codex-cli 0.154.0` → `0.154.0`).
 *
 * @param binary - The `codex` executable.
 */
export function readCodexBinaryVersion(binary: string): string {
  const out = withScratchHome((env) =>
    execFileSync(binary, ['--version'], { encoding: 'utf8', env })
  );
  const match = /(\d+\.\d+\.\d+\S*)/.exec(out);
  if (!match) throw new Error(`Could not read a version from: ${out.trim()}`);
  return match[1]!;
}

/**
 * Generate the binary's JSON Schemas into `outDir` (experimental surface). The
 * generator reads no config and makes no network call.
 *
 * @param binary - The `codex` executable.
 * @param outDir - An empty directory.
 */
export function generateProtocolSchemas(binary: string, outDir: string): void {
  withScratchHome((env) =>
    execFileSync(
      binary,
      ['app-server', 'generate-json-schema', '--experimental', '--out', outDir],
      {
        stdio: 'ignore',
        env,
      }
    )
  );
}

/**
 * Run with a throwaway home and nothing inherited, so the binary cannot read
 * (or write) anybody's Codex setup.
 */
function withScratchHome<T>(run: (env: NodeJS.ProcessEnv) => T): T {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-schema-home-'));
  try {
    return run({ PATH: '/usr/bin:/bin', HOME: home, CODEX_HOME: home });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/** Where the committed snapshot lives. */
export const PROTOCOL_SNAPSHOT_FILE = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  'schema-snapshot.json'
);
