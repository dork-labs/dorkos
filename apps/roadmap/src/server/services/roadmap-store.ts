/**
 * Persistent data layer for roadmap items using lowdb.
 *
 * Wraps lowdb with JSONFile adapter for atomic JSON persistence.
 * Provides CRUD operations, reordering, and health stats computation.
 *
 * @module server/services/roadmap-store
 */
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import { v4 as uuidv4 } from 'uuid';
import type {
  RoadmapItem,
  RoadmapMeta,
  HealthStats,
  TimeHorizonConfig,
} from '@dorkos/shared/roadmap-schemas';
import type { Adapter } from 'lowdb';

interface RoadmapData {
  projectName: string;
  projectSummary: string;
  lastUpdated: string;
  timeHorizons: {
    now: TimeHorizonConfig;
    next: TimeHorizonConfig;
    later: TimeHorizonConfig;
  };
  items: RoadmapItem[];
}

type CreateItemInput = Omit<RoadmapItem, 'id' | 'createdAt' | 'updatedAt'>;

const DEFAULT_DATA: RoadmapData = {
  projectName: '',
  projectSummary: '',
  lastUpdated: '',
  timeHorizons: {
    now: { label: '', description: '' },
    next: { label: '', description: '' },
    later: { label: '', description: '' },
  },
  items: [],
};

/**
 * Persistent store for roadmap data backed by lowdb.
 *
 * Call `init()` after construction to read from disk before using other methods.
 */
export class RoadmapStore {
  private db: Low<RoadmapData>;

  constructor(filePath: string);
  constructor(adapter: Adapter<RoadmapData>);
  constructor(filePathOrAdapter: string | Adapter<RoadmapData>) {
    const adapter =
      typeof filePathOrAdapter === 'string'
        ? new JSONFile<RoadmapData>(filePathOrAdapter)
        : filePathOrAdapter;
    this.db = new Low(adapter, { ...DEFAULT_DATA, items: [] });
  }

  /** Read data from the underlying adapter into memory. */
  async init(): Promise<void> {
    await this.db.read();
  }

  /** Return all roadmap items. */
  listItems(): RoadmapItem[] {
    return this.db.data.items;
  }

  /** Find a single item by id. Returns undefined if not found. */
  getItem(id: string): RoadmapItem | undefined {
    return this.db.data.items.find((item) => item.id === id);
  }

  /**
   * Create a new roadmap item with auto-generated id and timestamps.
   *
   * @param input - Item fields excluding id, createdAt, updatedAt
   */
  async createItem(input: CreateItemInput): Promise<RoadmapItem> {
    const now = new Date().toISOString();
    const item: RoadmapItem = {
      ...input,
      id: uuidv4(),
      createdAt: now,
      updatedAt: now,
    };
    this.db.data.items.push(item);
    this.db.data.lastUpdated = now;
    await this.db.write();
    return item;
  }

  /**
   * Partially update an existing item. Sets updatedAt on each mutation.
   *
   * @param id - Item UUID to update
   * @param patch - Partial fields to merge
   * @returns Updated item, or null if not found
   */
  async updateItem(id: string, patch: Partial<RoadmapItem>): Promise<RoadmapItem | null> {
    const idx = this.db.data.items.findIndex((item) => item.id === id);
    if (idx === -1) return null;

    const now = new Date().toISOString();
    this.db.data.items[idx] = { ...this.db.data.items[idx], ...patch, updatedAt: now };
    this.db.data.lastUpdated = now;
    await this.db.write();
    return this.db.data.items[idx];
  }

  /**
   * Delete an item by id.
   *
   * @param id - Item UUID to delete
   * @returns true if deleted, false if not found
   */
  async deleteItem(id: string): Promise<boolean> {
    const idx = this.db.data.items.findIndex((item) => item.id === id);
    if (idx === -1) return false;

    this.db.data.items.splice(idx, 1);
    this.db.data.lastUpdated = new Date().toISOString();
    await this.db.write();
    return true;
  }

  /**
   * Reorder items by setting the order field based on array position.
   *
   * @param orderedIds - Item UUIDs in desired order
   */
  async reorder(orderedIds: string[]): Promise<void> {
    orderedIds.forEach((id, index) => {
      const item = this.db.data.items.find((i) => i.id === id);
      if (item) item.order = index;
    });
    this.db.data.lastUpdated = new Date().toISOString();
    await this.db.write();
  }

  /** Return project metadata with computed health statistics. */
  getMeta(): RoadmapMeta & { health: HealthStats } {
    const items = this.db.data.items;
    const mustHaves = items.filter((i) => i.moscow === 'must-have');
    return {
      projectName: this.db.data.projectName,
      projectSummary: this.db.data.projectSummary,
      lastUpdated: this.db.data.lastUpdated,
      timeHorizons: this.db.data.timeHorizons,
      health: {
        totalItems: items.length,
        mustHavePercent:
          items.length > 0 ? Math.round((mustHaves.length / items.length) * 100) : 0,
        inProgressCount: items.filter((i) => i.status === 'in-progress').length,
        atRiskCount: items.filter((i) => i.health === 'at-risk').length,
        blockedCount: items.filter((i) => i.health === 'blocked').length,
        completedCount: items.filter((i) => i.status === 'completed').length,
      },
    };
  }
}

export type { RoadmapData, CreateItemInput };
