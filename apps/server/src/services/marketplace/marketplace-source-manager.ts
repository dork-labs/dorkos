/**
 * Marketplace source manager — owns CRUD for `${dorkHome}/marketplaces.json`
 * and seeds the default community sources on first run.
 *
 * The on-disk file is the source of truth; the manager holds no in-memory
 * state across calls. Writes are atomic (tmp + rename) so a crash mid-write
 * never corrupts the canonical file.
 *
 * @module services/marketplace/marketplace-source-manager
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { MarketplaceSource } from './types.js';

/** Zod schema for a single configured marketplace source. */
const MarketplaceSourceSchema = z.object({
  name: z.string().min(1),
  source: z.string().min(1),
  enabled: z.boolean(),
  addedAt: z.string().min(1),
});

/** Zod schema for the on-disk `marketplaces.json` envelope. */
const MarketplacesFileSchema = z.object({
  version: z.literal(1),
  sources: z.array(MarketplaceSourceSchema),
});

type MarketplacesFile = z.infer<typeof MarketplacesFileSchema>;

/** File name for the marketplaces config inside `dorkHome`. */
const MARKETPLACES_FILENAME = 'marketplaces.json';

/**
 * Canonical URL for the Dork Labs community marketplace. Prior versions
 * seeded `https://github.com/dorkos/marketplace` which was an ambiguous
 * placeholder — the real repository lives under the `dork-labs` org.
 * Kept as a module-level constant so the migration (see
 * {@link migrateKnownBadSources}) and the default seed stay in sync.
 */
const DORKOS_COMMUNITY_URL = 'https://github.com/dork-labs/marketplace';

/**
 * Map of legacy marketplace source URLs that shipped in earlier DorkOS
 * builds but were known-broken. When we encounter one of these in an
 * existing `marketplaces.json`, we rewrite it in place the next time
 * the file is read. Add entries as `[oldUrl, newUrl]` tuples — the
 * migration runs once per read and no-ops when nothing matches.
 */
const LEGACY_SOURCE_MIGRATIONS: ReadonlyMap<string, string> = new Map([
  ['https://github.com/dorkos/marketplace', DORKOS_COMMUNITY_URL],
]);

/** Default sources seeded the first time the file is read. */
function buildDefaultSources(): MarketplaceSource[] {
  const now = new Date().toISOString();
  return [
    {
      name: 'dorkos-community',
      source: DORKOS_COMMUNITY_URL,
      enabled: true,
      addedAt: now,
    },
    {
      name: 'claude-plugins-official',
      source: 'https://github.com/anthropics/claude-plugins-official',
      enabled: true,
      addedAt: now,
    },
  ];
}

/**
 * Rewrite any sources whose URL matches a known-bad legacy URL. Returns
 * the number of entries that were rewritten so the caller can decide
 * whether to persist the file.
 */
function migrateKnownBadSources(sources: MarketplaceSource[]): number {
  let rewrites = 0;
  for (const source of sources) {
    const replacement = LEGACY_SOURCE_MIGRATIONS.get(source.source);
    if (replacement !== undefined) {
      source.source = replacement;
      rewrites += 1;
    }
  }
  return rewrites;
}

/**
 * Owns the lifecycle of `${dorkHome}/marketplaces.json` — listing, adding,
 * removing, enabling, and disabling configured marketplace sources.
 *
 * The constructor takes `dorkHome` as a required parameter; this class
 * never falls back to `os.homedir()` and never invents a default location.
 */
export class MarketplaceSourceManager {
  private readonly filePath: string;

  /**
   * Construct a manager rooted at the given dorkHome directory.
   *
   * @param dorkHome - Absolute path to the DorkOS data directory
   */
  constructor(private readonly dorkHome: string) {
    this.filePath = join(dorkHome, MARKETPLACES_FILENAME);
  }

  /**
   * List all configured marketplace sources.
   *
   * On first call (when the file is missing), seeds the defaults to disk
   * and returns them. Throws a clear error if the file exists but contains
   * invalid data.
   */
  async list(): Promise<MarketplaceSource[]> {
    const file = await this.readFileOrSeed();
    return file.sources;
  }

  /**
   * Get a single configured source by name.
   *
   * @param name - The user-chosen identifier of the source
   * @returns The source, or `null` if no source with that name exists
   */
  async get(name: string): Promise<MarketplaceSource | null> {
    const sources = await this.list();
    return sources.find((s) => s.name === name) ?? null;
  }

  /**
   * Add a new marketplace source and persist it to disk.
   *
   * @param input - The new source spec (`enabled` defaults to `true`)
   * @returns The newly added source with `addedAt` filled in
   * @throws Error when a source with the same name already exists
   */
  async add(input: {
    name: string;
    source: string;
    enabled?: boolean;
  }): Promise<MarketplaceSource> {
    const file = await this.readFileOrSeed();
    if (file.sources.some((s) => s.name === input.name)) {
      throw new Error(`Marketplace source '${input.name}' already exists`);
    }
    const created: MarketplaceSource = {
      name: input.name,
      source: input.source,
      enabled: input.enabled ?? true,
      addedAt: new Date().toISOString(),
    };
    file.sources.push(created);
    await this.writeFile(file);
    return created;
  }

  /**
   * Remove a marketplace source by name. No-op if no such source exists.
   *
   * @param name - The user-chosen identifier of the source to remove
   */
  async remove(name: string): Promise<void> {
    const file = await this.readFileOrSeed();
    const next = file.sources.filter((s) => s.name !== name);
    if (next.length === file.sources.length) {
      return;
    }
    await this.writeFile({ version: 1, sources: next });
  }

  /**
   * Enable or disable a marketplace source and persist the change.
   *
   * @param name - The user-chosen identifier of the source
   * @param enabled - The new enabled flag
   * @returns The updated source
   * @throws Error when no source with the given name exists
   */
  async setEnabled(name: string, enabled: boolean): Promise<MarketplaceSource> {
    const file = await this.readFileOrSeed();
    const target = file.sources.find((s) => s.name === name);
    if (!target) {
      throw new Error(`Marketplace source '${name}' not found`);
    }
    target.enabled = enabled;
    await this.writeFile(file);
    return target;
  }

  /**
   * Read the marketplaces file from disk, seeding defaults on first run.
   * Throws a descriptive error when the file exists but is malformed.
   */
  private async readFileOrSeed(): Promise<MarketplacesFile> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        const seeded: MarketplacesFile = { version: 1, sources: buildDefaultSources() };
        await this.writeFile(seeded);
        return seeded;
      }
      throw err;
    }

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `Failed to parse ${this.filePath}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    const parsed = MarketplacesFileSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`Invalid marketplaces.json at ${this.filePath}: ${parsed.error.message}`);
    }

    // One-shot migration: rewrite any known-bad legacy URLs so existing
    // users pick up corrected defaults without needing to manually edit
    // their marketplaces.json. Only persists when something actually
    // changed to avoid churn on every read.
    const rewrites = migrateKnownBadSources(parsed.data.sources);
    if (rewrites > 0) {
      await this.writeFile(parsed.data);
    }

    return parsed.data;
  }

  /**
   * Atomically write the marketplaces file to disk via tmp + rename so a
   * crash mid-write never corrupts the canonical file.
   */
  private async writeFile(file: MarketplacesFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    const serialized = `${JSON.stringify(file, null, 2)}\n`;
    await writeFile(tmpPath, serialized, 'utf-8');
    await rename(tmpPath, this.filePath);
  }
}
