/**
 * Where an installed package would be reinstalled from: the marketplace that
 * lists it, its own recorded source (a direct install), or nowhere, and why.
 * Split from `update.ts`; it owns the marketplace-index memo, shared by every
 * check the one update flow runs.
 *
 * @module services/marketplace/flows/update-targets
 */
import type { MarketplaceJson, MarketplaceJsonEntry } from '@dorkos/marketplace';
import type { MarketplaceSource } from '../types.js';
import type { InstallationRecord } from '../installed-scanner.js';
import type { TtlMemo } from './update-memo.js';
import type { UpdateFlowDeps } from './update-types.js';

/** The note on a direct install checked against its default branch. */
const DEFAULT_BRANCH_NOTE =
  'checked against the default branch: this package was installed before DorkOS recorded which branch it came from';

/** Where an installed package would be reinstalled from. */
export type UpdateTarget =
  | { kind: 'marketplace'; marketplaceName: string }
  | { kind: 'direct'; source: string; note?: string }
  | { kind: 'none'; note: string };

/** Finds each package's reinstall source, reading each marketplace index once per memo window. */
export class UpdateTargets {
  /**
   * Build the finder.
   *
   * @param deps - The source list, the index fetcher and the logger.
   * @param indexMemo - The memo of marketplace indexes, one per source.
   */
  constructor(
    private readonly deps: Pick<UpdateFlowDeps, 'sourceManager' | 'fetcher' | 'logger'>,
    private readonly indexMemo: TtlMemo<MarketplaceJson>
  ) {}

  /** Forget every memoized index, so the next check reads it again. */
  clearMemo(): void {
    this.indexMemo.clear();
  }

  /**
   * Decide where a package would be reinstalled from.
   *
   * A direct install (`name@url`, `github:`; no `installedFrom`, a recorded
   * `sourceRepo`) is checked against its own source, rebuilt from its recorded
   * `sourceKey` when there is one. Everything else searches the marketplaces:
   * `installedFrom` first if it is enabled, then every enabled source. The
   * MATCHED source is what the installer receives, never `installedFrom`
   * blindly, so a bare-name lookup cannot hit `AmbiguousPackageError` when
   * two sources list the package, and a disabled source is never used.
   *
   * @param name - The package, as the update names it.
   * @param recorded - The installation's install sidecar, if any.
   * @returns Where it would be reinstalled from, or why nowhere.
   */
  async find(name: string, recorded: InstallationRecord['metadata']): Promise<UpdateTarget> {
    if (!recorded?.installedFrom && recorded?.sourceRepo) {
      // No "apply reinstalls from the default branch" note: both direct forms
      // (`name@url`, `github:`) resolve to a ref-less url source, so a recorded
      // key is always the default branch (`ref: 'HEAD'`; `'main'` in sidecars
      // written before DOR-2248), `subpath: ''`, and apply matches it.
      return recorded.sourceKey
        ? { kind: 'direct', source: recorded.sourceKey.cloneUrl }
        : { kind: 'direct', source: recorded.sourceRepo, note: DEFAULT_BRANCH_NOTE };
    }

    const unreachable: string[] = [];
    const candidates: MarketplaceSource[] = [];
    if (recorded?.installedFrom) {
      const source = await this.deps.sourceManager.get(recorded.installedFrom);
      if (source?.enabled) candidates.push(source);
    }
    for (const source of await this.deps.sourceManager.list()) {
      if (source.enabled && !candidates.some((c) => c.name === source.name)) {
        candidates.push(source);
      }
    }

    for (const source of candidates) {
      const entry = await this.findEntry(source, name, unreachable);
      if (entry) return { kind: 'marketplace', marketplaceName: source.name };
    }
    return {
      kind: 'none',
      note:
        unreachable.length > 0
          ? `couldn't read the marketplace list from ${unreachable.join(', ')}`
          : 'no enabled marketplace lists this package',
    };
  }

  /**
   * Find a package's entry in one marketplace's index (memoized per source).
   * A fetch failure records the source as unreachable and reads as "not
   * listed here", so one unreachable marketplace never blocks the others —
   * but the check still says it could not read it.
   *
   * @internal
   */
  private async findEntry(
    source: MarketplaceSource,
    packageName: string,
    unreachable: string[]
  ): Promise<MarketplaceJsonEntry | undefined> {
    try {
      const json = await this.indexMemo.get(source.name, () =>
        this.deps.fetcher.fetchMarketplaceJson(source)
      );
      return json.plugins.find((entry) => entry.name === packageName);
    } catch (err) {
      this.deps.logger.warn('update-flow: failed to fetch marketplace.json', {
        marketplaceName: source.name,
        error: err instanceof Error ? err.message : String(err),
      });
      unreachable.push(source.name);
      return undefined;
    }
  }
}
