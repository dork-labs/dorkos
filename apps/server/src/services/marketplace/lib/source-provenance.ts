/**
 * Where an installed package came from: what the installer records in
 * `.dork/install-metadata.json` (the DOR-147 provenance fields and the
 * {@link SourceKey}), and the helpers the update check uses to tell whether
 * that place has moved since.
 *
 * `sourceKeyOf` (`@dorkos/marketplace`) owns the key's normalization itself;
 * this module adapts it to the installer's resolved sources, rebuilds a direct
 * install from the key it recorded, and names a key's host for a "couldn't
 * reach" message.
 *
 * @module services/marketplace/lib/source-provenance
 */
import {
  resolvePluginSource,
  sourceKeyOf,
  type PluginSource,
  type SourceKey,
} from '@dorkos/marketplace';
import type { ResolvedPackageSource } from '../package-resolver.js';

/**
 * Rebuild a direct install's source from the key it recorded. The resolver's
 * `name@url` input has no ref or subpath syntax, so re-resolving the URL would
 * silently check the default branch instead of the one the package came from.
 */
export function resolvedFromSourceKey(packageName: string, key: SourceKey): ResolvedPackageSource {
  const pluginSource: PluginSource =
    key.subpath === ''
      ? { source: 'url', url: key.cloneUrl, ref: key.ref }
      : { source: 'git-subdir', url: key.cloneUrl, path: key.subpath, ref: key.ref };
  return { kind: 'git', packageName, pluginSource };
}

/** Field-by-field equality of two {@link SourceKey}s. */
export function sameSourceKey(a: SourceKey, b: SourceKey): boolean {
  return a.cloneUrl === b.cloneUrl && a.subpath === b.subpath && a.ref === b.ref;
}

/**
 * The host a clone URL points at, for a "couldn't reach" message: the URL's
 * host, the host of an scp-style `git@host:owner/repo`, or the URL itself.
 */
export function hostOf(cloneUrl: string): string {
  try {
    const { host } = new URL(cloneUrl);
    if (host) return host;
  } catch {
    // Not a WHATWG URL — try the scp-style form below.
  }
  const scp = /^[^@/\s]+@([^:/\s]+):/.exec(cloneUrl);
  return scp?.[1] ?? cloneUrl;
}

/**
 * The {@link SourceKey} of a concrete, fetchable source. A string source is a
 * relative path inside a `file://` marketplace (a remote one was already
 * rewritten to `git-subdir` by `buildFetchableSource`), so it has no key.
 */
export function sourceKeyOfFetchable(source: PluginSource): SourceKey | undefined {
  if (typeof source === 'string') return undefined;
  return sourceKeyOf(resolvePluginSource(source, {}));
}

/**
 * Derive `.dork/install-metadata.json` source provenance (DOR-147) — the
 * source repo and requested ref — from a resolved package source.
 * Local-directory installs (`dorkos install ./path`) have no upstream repo
 * and return an empty object rather than fabricating one.
 *
 * `sourceRepo` is recorded exactly as the resolver already represents the
 * source: a bare `owner/repo` for `github`-form entries, a full URL for
 * `url`/`git-subdir` entries and legacy `gitUrl` resolutions, or the
 * marketplace's own source URL for same-repo relative-path packages.
 * `sourceRef` is only populated when the source explicitly requested one —
 * the resolvers' implicit `main` default is never recorded here, so its
 * absence means "no ref was requested," not "resolved to main."
 */
export function deriveSourceProvenance(resolved: ResolvedPackageSource): {
  sourceRepo?: string;
  sourceRef?: string;
} {
  if (resolved.kind === 'local') {
    return {};
  }

  const source = resolved.pluginSource;
  if (source === undefined) {
    // Legacy bare-gitUrl resolution (pre-superset install inputs).
    return { sourceRepo: resolved.gitUrl };
  }
  if (typeof source === 'string') {
    // Relative-path source: the plugin lives inside the marketplace's own
    // repo, so the marketplace source URL IS the source repo.
    return { sourceRepo: resolved.marketplaceSourceUrl };
  }

  switch (source.source) {
    case 'github':
      return { sourceRepo: source.repo, sourceRef: source.ref };
    case 'url':
      return { sourceRepo: source.url, sourceRef: source.ref };
    case 'git-subdir':
      return { sourceRepo: source.url, sourceRef: source.ref };
    case 'npm':
      // Not git-backed — no repo/ref to record. (Install currently throws
      // NpmSourceNotSupportedError before reaching this point anyway.)
      return {};
  }
}
