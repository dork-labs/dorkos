import { createHash } from 'node:crypto';
import {
  DISTRIBUTION,
  InspectionFailure,
  LIMITS,
  ManifestSchema,
  PointerSchema,
  equalIdentity,
  relativePath,
  requireIdentity,
  trustedPath,
  type Identity,
  type RuntimeStatus,
} from './records.js';
import { InspectionOwner, type InspectionPort, type Root } from './owner.js';
import { scanJSON } from './scanner.js';

const PINNED = Object.freeze({
  pinnedPackageVersion: '1.63.0' as const,
  chromiumRevision: '1243',
  observedVersion: '153.0.8010.12',
});
type Snapshot = Readonly<{ path: string; identity: Identity }>;
/** Project only a closed own data field; thrown objects carry no diagnostic authority. */
function failureState(error: unknown): 'invalid' | 'unverified' {
  try {
    if (error instanceof InspectionFailure) {
      const descriptor = Object.getOwnPropertyDescriptor(error, 'state');
      if (descriptor && 'value' in descriptor && descriptor.value === 'invalid') return 'invalid';
    }
  } catch {
    // Reflection can itself throw; the fixed refusal must still settle.
  }
  return 'unverified';
}
/** Fold the complete bounded filename/hash census, not an expected-count substitute for traversal. */
export function distributionDigest(
  files: readonly Readonly<{ path: string; sha256: string }>[]
): string {
  if (files.length !== 114 || new Set(files.map((f) => f.path)).size !== 114)
    throw new InspectionFailure('invalid');
  const digest = createHash('sha256');
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    if (!relativePath.safeParse(file.path).success || !/^[a-f0-9]{64}$/.test(file.sha256))
      throw new InspectionFailure('invalid');
    digest.update(file.path + '\0' + file.sha256 + '\n');
  }
  return digest.digest('hex');
}

class FilesInspection {
  private readonly correlated = new Map<string, { root: Root; path: string; identity: Identity }>();
  constructor(private readonly owner: InspectionOwner) {}
  private correlate(root: Root, path: string, identity: Identity): void {
    const key = root + ':' + path;
    const old = this.correlated.get(key);
    if (old && !equalIdentity(old.identity, identity)) throw new InspectionFailure('unverified');
    this.correlated.set(key, { root, path, identity });
  }
  private async snapshots(root: Root, path: string): Promise<Snapshot[]> {
    const names = [''];
    let next = '';
    for (const segment of path.split('/').slice(0, -1)) {
      next = next ? next + '/' + segment : segment;
      names.push(next);
    }
    const result: Snapshot[] = [];
    for (const name of names) {
      const n = await this.owner.observe(root, name);
      if (n.state !== 'present') throw new InspectionFailure('unverified');
      const identity = requireIdentity(n.identity);
      if (identity.type !== 'directory') throw new InspectionFailure('unverified');
      this.correlate(root, name, identity);
      result.push({ path: name, identity });
    }
    return result;
  }
  private async unchanged(root: Root, snapshots: readonly Snapshot[]): Promise<void> {
    for (const snapshot of snapshots) {
      const n = await this.owner.observe(root, snapshot.path);
      if (n.state !== 'present' || !equalIdentity(snapshot.identity, requireIdentity(n.identity)))
        throw new InspectionFailure('unverified');
    }
  }
  private async named(root: Root, path: string): Promise<Identity> {
    const n = await this.owner.observe(root, path);
    if (n.state === 'unknown') throw new InspectionFailure('unverified');
    if (n.state === 'absent') throw new InspectionFailure('invalid');
    const identity = requireIdentity(n.identity);
    this.correlate(root, path, identity);
    return identity;
  }
  private async finish(
    root: Root,
    path: string,
    identity: Identity,
    parents: readonly Snapshot[]
  ): Promise<void> {
    if (!equalIdentity(identity, await this.owner.observeHeld()))
      throw new InspectionFailure('unverified');
    if (!equalIdentity(identity, await this.named(root, path)))
      throw new InspectionFailure('unverified');
    await this.unchanged(root, parents);
    await this.owner.close();
    if (!equalIdentity(identity, await this.named(root, path)))
      throw new InspectionFailure('unverified');
    await this.unchanged(root, parents);
  }
  async file(
    root: Root,
    path: string,
    cap: number,
    retain: boolean,
    onBytes?: (bytes: Uint8Array) => void
  ): Promise<{ bytes: Uint8Array; identity: Identity; sha256: string; length: number }> {
    const parents = await this.snapshots(root, path);
    const identity = await this.named(root, path);
    if (identity.type !== 'file') throw new InspectionFailure('unverified');
    if (BigInt(identity.size) > BigInt(cap)) throw new InspectionFailure('unverified');
    const bytes = retain ? this.owner.allocate(cap + 1) : new Uint8Array(0);
    const digest = createHash('sha256');
    let offset = 0;
    try {
      await this.owner.open(root, path, identity);
      if (!equalIdentity(identity, await this.owner.observeHeld()))
        throw new InspectionFailure('unverified');
      while (true) {
        const length = Math.min(LIMITS.buffer, cap - offset + 1);
        const n = await this.owner.read(offset, length);
        if (!n) break;
        offset += n;
        const chunk = this.owner.buffer.subarray(0, n);
        onBytes?.(chunk);
        if (offset > cap) throw new InspectionFailure('unverified');
        digest.update(chunk);
        if (retain) bytes.set(chunk, offset - n);
      }
      if (BigInt(offset) !== BigInt(identity.size)) throw new InspectionFailure('unverified');
      await this.finish(root, path, identity, parents);
      return {
        bytes: bytes.subarray(0, offset),
        identity,
        sha256: digest.digest('hex'),
        length: offset,
      };
    } catch (e) {
      if (retain) this.owner.release(bytes);
      throw e;
    }
  }
  async library(): Promise<{ packageJSON: unknown; browsersJSON: unknown }> {
    const frontier = [{ path: '', depth: 0 }];
    let encountered = 0,
      frontierBytes = 0,
      total = 0;
    const files: { path: string; sha256: string }[] = [];
    let packageJSON: unknown, browsersJSON: unknown;
    while (frontier.length) {
      const item = frontier.pop()!;
      const parents = await this.snapshots('library', item.path);
      const identity = await this.named('library', item.path);
      if (identity.type !== 'directory') throw new InspectionFailure('unverified');
      await this.owner.open('library', item.path, identity);
      if (!equalIdentity(identity, await this.owner.observeHeld()))
        throw new InspectionFailure('unverified');
      const children: { path: string; depth: number; type: 'file' | 'directory' }[] = [];
      while (true) {
        const entry = await this.owner.next();
        if (entry === null) break;
        if (++encountered > LIMITS.entries) throw new InspectionFailure('unverified');
        if (
          !entry ||
          typeof entry.name !== 'string' ||
          entry.name.includes('/') ||
          !relativePath.safeParse(entry.name).success ||
          !['file', 'directory'].includes(entry.type)
        )
          throw new InspectionFailure('unverified');
        const path = item.path ? item.path + '/' + entry.name : entry.name;
        if (!relativePath.safeParse(path).success || item.depth + 1 > LIMITS.depth)
          throw new InspectionFailure('unverified');
        if (children.some((c) => c.path === path)) throw new InspectionFailure('invalid');
        children.push({ path, depth: item.depth + 1, type: entry.type as 'file' | 'directory' });
        frontierBytes += new TextEncoder().encode(JSON.stringify(children.at(-1))).byteLength;
        if (children.length + frontier.length > LIMITS.entries || frontierBytes > LIMITS.frontier)
          throw new InspectionFailure('unverified');
      }
      await this.finish('library', item.path, identity, parents);
      for (const child of children) {
        const observed = await this.named('library', child.path);
        frontierBytes += new TextEncoder().encode(JSON.stringify(observed)).byteLength;
        if (frontierBytes > LIMITS.frontier || observed.type !== child.type)
          throw new InspectionFailure('unverified');
        if (child.type === 'directory') {
          frontier.push(child);
          continue;
        }
        const metadata = child.path === 'package.json' || child.path === 'browsers.json';
        const value = await this.file(
          'library',
          child.path,
          metadata ? LIMITS.manifest : LIMITS.file,
          metadata,
          (chunk) => {
            total += chunk.byteLength;
            if (total > LIMITS.library) throw new InspectionFailure('unverified');
          }
        );
        files.push({ path: child.path, sha256: value.sha256 });
        if (metadata) {
          try {
            const data = scanJSON(value.bytes);
            if (child.path === 'package.json') packageJSON = data;
            else browsersJSON = data;
          } finally {
            this.owner.release(value.bytes);
          }
        }
      }
    }
    if (distributionDigest(files) !== DISTRIBUTION) throw new InspectionFailure('invalid');
    return { packageJSON, browsersJSON };
  }
  async inspect(): Promise<
    { state: 'missing' } | { state: 'installed'; executableSHA256: string }
  > {
    const root = await this.snapshots('cache', 'current.json');
    const initial = await this.owner.observe('cache', 'current.json');
    if (initial.state === 'unknown') throw new InspectionFailure('unverified');
    if (initial.state === 'absent') {
      await this.unchanged('cache', root);
      const final = await this.owner.observe('cache', 'current.json');
      if (final.state !== 'absent') throw new InspectionFailure('unverified');
      await this.unchanged('cache', root);
      return { state: 'missing' };
    }
    const first = await this.file('cache', 'current.json', LIMITS.pointer, true);
    try {
      const parsed = PointerSchema.safeParse(scanJSON(first.bytes));
      if (!parsed.success) throw new InspectionFailure('invalid');
      const pointer = parsed.data;
      const candidate = 'candidates/' + pointer.installationId;
      const raw = await this.file('cache', candidate + '/manifest.json', LIMITS.manifest, true);
      let manifest;
      try {
        const m = ManifestSchema.safeParse(scanJSON(raw.bytes));
        if (!m.success || raw.sha256 !== pointer.manifestDigest)
          throw new InspectionFailure('invalid');
        manifest = m.data;
      } finally {
        this.owner.release(raw.bytes);
      }
      if (
        manifest.installationId !== pointer.installationId ||
        manifest.libraryDistributionSHA256 !== DISTRIBUTION ||
        manifest.chromiumRevision !== PINNED.chromiumRevision ||
        manifest.observedVersion !== PINNED.observedVersion ||
        manifest.platform !== 'darwin' ||
        manifest.arch !== 'arm64'
      )
        throw new InspectionFailure('invalid');
      const library = await this.library();
      const pkg = library.packageJSON as { name?: unknown; version?: unknown } | null;
      const browsers = library.browsersJSON as { browsers?: unknown } | null;
      if (
        pkg?.name !== 'playwright-core' ||
        pkg.version !== PINNED.pinnedPackageVersion ||
        !Array.isArray(browsers?.browsers)
      )
        throw new InspectionFailure('invalid');
      const chromium = browsers.browsers.filter(
        (b: unknown) =>
          b !== null && typeof b === 'object' && (b as { name?: unknown }).name === 'chromium'
      ) as { revision?: unknown; browserVersion?: unknown }[];
      if (
        chromium.length !== 1 ||
        chromium[0]!.revision !== PINNED.chromiumRevision ||
        chromium[0]!.browserVersion !== PINNED.observedVersion
      )
        throw new InspectionFailure('invalid');
      const executable = await this.file(
        'cache',
        candidate + '/' + manifest.executablePath,
        LIMITS.executable,
        false
      );
      if (executable.sha256 !== manifest.executableSHA256) throw new InspectionFailure('invalid');
      let final: Awaited<ReturnType<FilesInspection['file']>>;
      try {
        final = await this.file('cache', 'current.json', LIMITS.pointer, true);
      } catch {
        throw new InspectionFailure('unverified');
      }
      try {
        if (final.sha256 !== first.sha256 || !equalIdentity(final.identity, first.identity))
          throw new InspectionFailure('unverified');
      } finally {
        this.owner.release(final.bytes);
      }
      for (const observed of this.correlated.values())
        await this.unchanged(observed.root, [observed]);
      this.owner.check();
      return { state: 'installed', executableSHA256: executable.sha256 };
    } finally {
      this.owner.release(first.bytes);
    }
  }
}

/** Files-only private mock composition; no Node filesystem, verifier, installer or public wiring. */
export function createFilesInspector(
  options: Readonly<{
    cacheRoot: string;
    libraryRoot: string;
    platform: 'darwin' | 'linux' | 'win32';
    arch: 'arm64' | 'x64';
    signal: AbortSignal;
    now: () => number;
    port: InspectionPort;
  }>
) {
  options = Object.freeze({ ...options });
  if (
    !['darwin', 'linux', 'win32'].includes(options.platform) ||
    !['arm64', 'x64'].includes(options.arch)
  )
    throw new InspectionFailure('unverified');
  if (
    !trustedPath.safeParse(options.cacheRoot).success ||
    !trustedPath.safeParse(options.libraryRoot).success
  )
    throw new InspectionFailure('unverified');
  const owner = new InspectionOwner(
    options.port,
    options.now,
    options.signal,
    Object.freeze({ cache: options.cacheRoot, library: options.libraryRoot })
  );
  let active: Promise<RuntimeStatus> | null = null;
  const status = (state: RuntimeStatus['state'], executableSHA256?: string): RuntimeStatus =>
    Object.freeze({
      schemaVersion: 1,
      pinnedPackageVersion: PINNED.pinnedPackageVersion,
      chromiumRevision: PINNED.chromiumRevision,
      platform: options.platform,
      arch: options.arch,
      observation: 'files-only',
      readiness: Object.freeze({ state: 'unavailable', cause: 'VERIFICATION_UNAVAILABLE' }),
      state,
      cause:
        state === 'installed' || state === 'missing'
          ? null
          : state === 'invalid'
            ? 'INSTALLATION_INVALID'
            : state === 'unsupported'
              ? 'PLATFORM_UNSUPPORTED'
              : 'VERIFICATION_UNAVAILABLE',
      ...(state === 'installed' ? { executableSHA256 } : {}),
    }) as RuntimeStatus;
  return Object.freeze({
    custody: () => owner.custody(),
    inspectExisting(): Promise<RuntimeStatus> {
      if (active) return active;
      let resolve!: (value: RuntimeStatus) => void;
      const operation = Object.freeze(
        new Promise<RuntimeStatus>((done) => {
          resolve = done;
        })
      );
      active = operation;
      void operation.then(() => {
        if (active === operation) active = null;
      });
      if (options.platform !== 'darwin' || options.arch !== 'arm64') {
        resolve(status('unsupported'));
        return operation;
      }
      void (async () => {
        try {
          owner.begin();
          const result = await new FilesInspection(owner).inspect();
          owner.check();
          const custody = owner.custody();
          if (custody.operation || custody.handle) throw new InspectionFailure('unverified');
          resolve(
            status(result.state, 'executableSHA256' in result ? result.executableSHA256 : undefined)
          );
        } catch (e) {
          owner.retire();
          resolve(status(failureState(e)));
        } finally {
          owner.finish();
        }
      })();
      return operation;
    },
  });
}
