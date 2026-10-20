/**
 * The shapes of the runtime capabilities matrix: its columns, groups, cells
 * and rows. The rows themselves live in `runtime-capability-matrix`, which
 * re-exports everything here, so callers import from there.
 *
 * @module test-utils/runtime-capability-types
 */
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';

/** The runtimes the matrix has a column for, in column order. */
export const MATRIX_RUNTIMES = ['claude-code', 'codex', 'opencode', 'doe', 'test-mode'] as const;

/** One runtime column of the matrix. */
export type MatrixRuntime = (typeof MATRIX_RUNTIMES)[number];

/**
 * How far one runtime gets with one capability.
 *
 * - `supported` — it does what the row says.
 * - `partial` — it does some of it; the reason says what is missing.
 * - `unverified` — it says it does (a declared flag, shipped code), and no test
 *   proves it yet. A gap in proof, not in the product.
 * - `planned` — it does not yet, and a ticket will make it.
 * - `not-supported` — it does not, and nothing is planned; the reason says why.
 * - `n/a` — the capability does not apply to this runtime.
 */
export type CellStatus =
  'supported' | 'partial' | 'unverified' | 'planned' | 'not-supported' | 'n/a';

/** A tier of proof; see "Evidence tiers" in `runtime-capability-matrix`. */
export type EvidenceTier = 'U' | 'E' | 'L';

/** One runtime's answer to one capability. */
export interface MatrixCell {
  /** How far this runtime gets. */
  status: CellStatus;
  /** Why, in one sentence. Required for every status but `supported`. */
  reason?: string;
  /** The tiers of proof this cell claims. A `U` claim is checked by the census. */
  evidence?: readonly EvidenceTier[];
  /** The tracker item that will change this cell. Required for `planned`. */
  ticket?: string;
}

/** The groups the matrix is arranged in, in document order, with their headings. */
export const MATRIX_GROUPS = {
  SES: 'Sessions',
  STR: 'Streaming and history',
  TOOL: 'Tools and approvals',
  ASK: 'Questions',
  PERM: 'Permission modes',
  MOD: 'Models and effort',
  ACCT: 'Accounts and credits',
  MCP: 'MCP',
  PLG: 'Plugins, prompts and folders',
  DISP: 'Steer, stage and queue',
  STOP: 'Stopping a turn',
  LIFE: 'Background work and turn lifecycle',
  MEDIA: 'Attachments and media',
  COST: 'Cost and usage',
  CMP: 'Compaction',
} as const;

/** A group key. */
export type MatrixGroup = keyof typeof MATRIX_GROUPS;

/**
 * A declared capability a row agrees with: what it is called in the doc, and
 * how to read it off a runtime's `RuntimeCapabilities`. When a row has one, the
 * census holds every cell to it: declared true means `supported`, `partial` or
 * `unverified`; declared false means anything else.
 */
export interface MatrixFlag {
  /** How the doc names it, e.g. `supportsSteer`. */
  label: string;
  /** Reads the flag off a runtime's declared capabilities. */
  read: (caps: RuntimeCapabilities) => boolean;
}

/** One capability: a row of the matrix. */
export interface RuntimeCapability {
  /** `RT-<GROUP>-<NN>`; a test claims the row by starting its title with it. */
  id: string;
  /** The group it sits in. */
  group: MatrixGroup;
  /** A short name. */
  title: string;
  /** What a runtime that has this capability does, in one sentence. */
  expected: string;
  /** The declared capability this row must agree with, if any. */
  flag?: MatrixFlag;
  /**
   * Shared conformance case ids (`C4`, `I2`) that prove this row. A title that
   * starts with one counts for this row, as a title starting with the row id
   * does.
   */
  conformance?: readonly string[];
  /** One cell per runtime. */
  cells: Readonly<Record<MatrixRuntime, MatrixCell>>;
}

/** The statuses that mean the runtime has the capability, proven or not. */
export const HAS_CAPABILITY: ReadonlySet<CellStatus> = new Set([
  'supported',
  'partial',
  'unverified',
]);
