/**
 * Server-side contiguous port-block allocation (DOR-84 / DOR-85 folded in).
 *
 * Each workspace owns a disjoint contiguous block `[portBase, portBase + size)`;
 * the three named dev ports derive from it by fixed offset (see `derivePorts`).
 * Because blocks never overlap, the branch-name-hash collision class the old
 * `worktree-setup.sh` papered over with linear probing is structurally
 * impossible. Allocation is cache-derived — a block is freed implicitly when its
 * workspace row leaves the cache, so there is no separate release step.
 *
 * @module server/services/workspace/port-allocator
 */
import { derivePorts, type WorkspacePorts } from '@dorkos/shared/workspace';

const MAX_PORT = 65535;

/** Configuration for the allocation pool. */
export interface PortAllocatorConfig {
  /** First port of the pool (default 4250). */
  portBase: number;
  /** Size of each per-workspace block (default 10). */
  portBlockSize: number;
}

/**
 * The lowest free block base ≥ `portBase`, stepping by `blockSize`, skipping any
 * base already in `used`. Pure and exhaustively testable.
 *
 * @param used - Currently allocated block bases.
 * @param portBase - Pool start.
 * @param blockSize - Block stride.
 * @throws If the pool is exhausted before reaching the 65535 ceiling.
 */
export function lowestFreeBlock(
  used: Iterable<number>,
  portBase: number,
  blockSize: number
): number {
  const taken = new Set(used);
  for (let base = portBase; base + blockSize - 1 <= MAX_PORT; base += blockSize) {
    if (!taken.has(base)) return base;
  }
  throw new Error(
    `Workspace port pool exhausted (base ${portBase}, block ${blockSize}, ceiling ${MAX_PORT})`
  );
}

/** Allocates contiguous port blocks for workspaces from a live view of the cache. */
export class PortAllocator {
  constructor(
    private readonly config: PortAllocatorConfig,
    /** Returns the bases currently allocated (read from the workspace cache). */
    private readonly listAllocatedBases: () => number[]
  ) {}

  /** Allocate the lowest free block base. */
  allocate(): number {
    return lowestFreeBlock(
      this.listAllocatedBases(),
      this.config.portBase,
      this.config.portBlockSize
    );
  }

  /** The named dev ports for a given block base. */
  ports(portBase: number): WorkspacePorts {
    return derivePorts(portBase);
  }
}
