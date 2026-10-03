import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import corpus from './source-corpus.json' with { type: 'json' };
import { DISTRIBUTION, type Identity } from '../records.js';
import { type InspectionPort, type Lease, type Handle, type Root } from '../owner.js';
import { createFilesInspector } from '../inspector.js';

const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
/** Authorized source-data reads only: no dependency execution or real filesystem identity port. */
const library = new Map(
  corpus.map((f) => {
    const bytes = new Uint8Array(
      readFileSync(resolve(import.meta.dirname, '../../../../node_modules/playwright-core', f.path))
    );
    if (bytes.length !== f.bytes || hash(bytes) !== f.sha256)
      throw Error('PINNED_SOURCE_INPUT_CHANGED');
    return [f.path, bytes] as const;
  })
);
if (library.size !== 114 || [...library.values()].reduce((n, b) => n + b.length, 0) !== 13453369)
  throw Error('SOURCE_CENSUS_CHANGED');
export { corpus };
export function fixture() {
  const executable = encode('MOCK_EXECUTABLE_BYTES_NOT_A_RUNTIME');
  const manifest = {
    schemaVersion: 1,
    installationId: 'fixture_installation',
    packageName: 'playwright-core',
    packageVersion: '1.63.0',
    libraryDistributionSHA256: DISTRIBUTION,
    chromiumRevision: '1243',
    observedVersion: '153.0.8010.12',
    platform: 'darwin',
    arch: 'arm64',
    executablePath: 'bin/chromium',
    executableSHA256: hash(executable),
    verifierEvidence: { attemptId: 'mock_attempt', generation: 0, evidenceDigest: 'a'.repeat(64) },
  };
  const manifestBytes = encode(manifest);
  const cache = new Map([
    [
      'current.json',
      encode({
        schemaVersion: 1,
        installationId: manifest.installationId,
        manifestDigest: hash(manifestBytes),
      }),
    ],
    ['candidates/fixture_installation/manifest.json', manifestBytes],
    ['candidates/fixture_installation/bin/chromium', executable],
  ]);
  const roots = { cache, library: new Map(library) };
  const controller = new AbortController();
  let clock = 0,
    held: Handle | null = null;
  const calls: { kind: string; lease: Lease; handle?: Handle; length?: number }[] = [];
  const identities = new Map<string, Identity>();
  const identity = (root: Root, path: string): Identity | null => {
    const key = root + ':' + path;
    if (identities.has(key)) return identities.get(key)!;
    const bytes = roots[root].get(path);
    const directory = path === '' || [...roots[root].keys()].some((n) => n.startsWith(path + '/'));
    if (!bytes && !directory) return null;
    const value: Identity = {
      device: '1',
      inode: String(identities.size + 1),
      size: String(bytes?.length ?? 0),
      mtimeNs: '0',
      ctimeNs: '0',
      type: bytes ? 'file' : 'directory',
    };
    identities.set(key, value);
    return value;
  };
  const state = new Map<Handle, { root: Root; path: string; entries: string[]; at: number }>();
  let observer: (kind: string, lease: Lease) => void = () => {};
  const record = (kind: string, lease: Lease, h?: Handle, length?: number) => {
    calls.push({ kind, lease, handle: h, length });
    observer(kind, lease);
  };
  const port: InspectionPort = {
    capabilities: {
      boundedIntake: true,
      noFollow: true,
      heldIdentity: true,
      exactClose: true,
      oneEntryPrefetch: true,
    },
    async observeNamed(lease) {
      record('observe', lease);
      const id = identity(lease.root, lease.path);
      return { lease, value: id ? { state: 'present', identity: id } : { state: 'absent' } };
    },
    async openRegular(lease) {
      record('open', lease);
      if (held) throw Error('MOCK_TWO_HANDLES');
      const handle: Handle = { kind: 'file', token: {} };
      held = handle;
      state.set(handle, { root: lease.root, path: lease.path, entries: [], at: 0 });
      return { lease, value: handle };
    },
    async openDirectory(lease) {
      record('directory', lease);
      if (held) throw Error('MOCK_TWO_HANDLES');
      const handle: Handle = { kind: 'directory', token: {} };
      held = handle;
      const prefix = lease.path ? lease.path + '/' : '';
      const entries = [
        ...new Set(
          [...roots[lease.root].keys()]
            .filter((p) => p.startsWith(prefix))
            .map((p) => p.slice(prefix.length).split('/')[0]!)
        ),
      ];
      state.set(handle, { root: lease.root, path: lease.path, entries, at: 0 });
      return { lease, value: handle };
    },
    async observeHeld(lease, handle) {
      record('held', lease, handle);
      if (handle !== held) throw Error('MOCK_HELD_AFTER_CLOSE');
      const v = state.get(handle)!;
      return { lease, handle, value: identity(v.root, v.path)! };
    },
    async readInto(lease, handle, buffer, offset, length) {
      record('read', lease, handle, length);
      const v = state.get(handle)!;
      const b = roots[v.root].get(v.path)!;
      const chunk = b.subarray(offset, offset + length);
      buffer.set(chunk);
      return { lease, handle, value: chunk.length };
    },
    async nextEntry(lease, handle) {
      record('next', lease, handle);
      const v = state.get(handle)!;
      const name = v.entries[v.at++];
      if (name === undefined) return { lease, handle, value: null };
      const path = v.path ? v.path + '/' + name : name;
      return {
        lease,
        handle,
        value: { name, type: roots[v.root].has(path) ? 'file' : 'directory' },
      };
    },
    async close(lease, handle) {
      record('close', lease, handle);
      if (handle !== held) throw Error('MOCK_WRONG_CLOSE');
      held = null;
      return { lease, handle, value: 'closed' };
    },
  };
  const inspector = createFilesInspector({
    cacheRoot: '/mock/cache',
    libraryRoot: '/mock/library',
    platform: 'darwin',
    arch: 'arm64',
    signal: controller.signal,
    now: () => clock,
    port,
  });
  return {
    inspector,
    port,
    calls,
    controller,
    roots,
    identities,
    manifest,
    identity,
    hash,
    encode,
    observe: (fn: typeof observer) => {
      observer = fn;
    },
    setClock: (n: number) => {
      clock = n;
    },
    get held() {
      return held;
    },
  };
}
