/**
 * The runtime capabilities matrix: what every agent runtime SHOULD do, and how
 * far each one gets (DOR-2720).
 *
 * A row is a capability with one sentence of expected behavior. A cell is one
 * runtime's answer to it: a status, why, what proves it, and the ticket that
 * will change it. The list is the spec, not an inventory of what happens to be
 * built: a capability nobody has built yet enters as a row whose cells are all
 * `planned`, each naming its ticket.
 *
 * Three things read this registry:
 *
 * - `contributing/capabilities/runtimes.md`, rendered from it by
 *   {@link renderRuntimeCapabilityMatrix} (`pnpm docs:runtime-capabilities`);
 * - the census in `apps/server/src/services/runtimes/__tests__/`, which holds
 *   every `U` claim to a test title that names the row, every flag-backed row
 *   to that runtime's declared capabilities, and the rendered doc to this file;
 * - a person comparing runtimes, who reads the doc.
 *
 * ## Evidence tiers
 *
 * - **U** — a deterministic test in CI: the shared conformance suite, run
 *   against a mocked backend for every runtime, or a runtime's own unit tests.
 * - **E** — a Playwright spec against the test-mode runtime.
 * - **L** — a live run against the real backend (an eval, a harness smoke, a
 *   live conformance run). Only L-proven cells may ever be claimed publicly.
 *
 * @module test-utils/runtime-capability-matrix
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

/** A tier of proof; see the module doc. */
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

const U = ['U'] as const;

/** A `supported` cell proven by a deterministic test. */
const yes: MatrixCell = { status: 'supported', evidence: U };

/** The same answer for every runtime. */
function all(cell: MatrixCell): Record<MatrixRuntime, MatrixCell> {
  return {
    'claude-code': cell,
    codex: cell,
    opencode: cell,
    doe: cell,
    'test-mode': cell,
  };
}

/** Builds a flag from a boolean field of `RuntimeCapabilities`. */
function flag(
  label: keyof RuntimeCapabilities,
  read: (caps: RuntimeCapabilities) => boolean = (caps) => caps[label] === true
): MatrixFlag {
  return { label, read };
}

const TEST_FIXTURE = 'test-mode is a scripted fixture with no backend behind it.';

/**
 * Every capability, in document order. Add a row here, run
 * `pnpm docs:runtime-capabilities`, and let the census say what else it needs.
 */
export const RUNTIME_CAPABILITIES: readonly RuntimeCapability[] = [
  // ── Sessions ────────────────────────────────────────────────────────────
  {
    id: 'RT-SES-01',
    group: 'SES',
    title: 'Track and look up sessions',
    expected:
      'A session the runtime started can be looked up by its id, and an unknown id answers null, never a guess.',
    cells: all(yes),
  },
  {
    id: 'RT-SES-02',
    group: 'SES',
    title: 'List a project’s sessions',
    expected:
      'Listing a project returns the sessions started inside it, including its subfolders, and never a lookalike sibling folder’s.',
    cells: all(yes),
  },
  {
    id: 'RT-SES-03',
    group: 'SES',
    title: 'Resume a conversation',
    expected:
      'A later message continues the same conversation with its history, including after the server restarts.',
    flag: flag('supportsResume'),
    cells: {
      'claude-code': yes,
      codex: {
        status: 'unverified',
        reason: 'Resumes its thread by id; no test pins a resumed turn seeing earlier history.',
      },
      opencode: {
        status: 'unverified',
        reason: 'Resumes its session by id; no test pins a resumed turn seeing earlier history.',
      },
      doe: yes,
      'test-mode': { status: 'unverified', reason: TEST_FIXTURE },
    },
  },
  {
    id: 'RT-SES-04',
    group: 'SES',
    title: 'One id for the whole conversation',
    expected:
      'The id DorkOS hands out for a new session is the id it is stored, listed and messaged under for its whole life (DOR-2712).',
    cells: {
      'claude-code': yes,
      codex: {
        status: 'unverified',
        reason: 'DorkOS keeps its own id and maps the thread to it; no test pins the round trip.',
      },
      opencode: {
        status: 'unverified',
        reason:
          'DorkOS keeps its own id and maps the sidecar session; no test pins the round trip.',
      },
      doe: yes,
      'test-mode': { status: 'unverified', reason: TEST_FIXTURE },
    },
  },
  {
    id: 'RT-SES-05',
    group: 'SES',
    title: 'Settings follow the session',
    expected:
      'A session whose backend renames it keeps the mode, model and effort the person chose.',
    cells: all(yes),
  },
  {
    id: 'RT-SES-06',
    group: 'SES',
    title: 'Find a session’s folder without a disk scan',
    expected:
      'The runtime answers which folder a live session works in from memory, and never throws.',
    conformance: ['C10'],
    cells: {
      'claude-code': yes,
      codex: { status: 'n/a', reason: 'Its sessions are not stored by folder.' },
      opencode: { status: 'n/a', reason: 'Its sessions are not stored by folder.' },
      doe: yes,
      'test-mode': { status: 'n/a', reason: 'Its sessions are not stored by folder.' },
    },
  },
  {
    id: 'RT-SES-07',
    group: 'SES',
    title: 'Fork a session',
    expected: 'A conversation can be copied into a new session that continues on its own.',
    cells: {
      'claude-code': yes,
      codex: {
        status: 'not-supported',
        reason: 'The Codex SDK has no fork; forkSession resolves null.',
      },
      opencode: yes,
      doe: { status: 'not-supported', reason: 'DorkOS does not expose this feature.' },
      'test-mode': { status: 'unverified', reason: TEST_FIXTURE },
    },
  },

  // ── Streaming and history ───────────────────────────────────────────────
  {
    id: 'RT-STR-01',
    group: 'STR',
    title: 'A well-formed turn stream',
    expected:
      'A turn yields only well-formed stream events and always ends with exactly one `done`.',
    cells: all(yes),
  },
  {
    id: 'RT-STR-02',
    group: 'STR',
    title: 'A failed turn says so',
    expected: 'A turn that fails yields a typed `error` event before its `done`, never silence.',
    cells: all(yes),
  },
  {
    id: 'RT-STR-03',
    group: 'STR',
    title: 'Never repeat the person’s message back',
    expected:
      'The agent’s output never echoes the trigger or any context DorkOS wrapped around it.',
    cells: all(yes),
  },
  {
    id: 'RT-STR-04',
    group: 'STR',
    title: 'Read a conversation’s history',
    expected:
      'After a turn completes, the session’s history reads back as messages, never a throw.',
    cells: all(yes),
  },
  {
    id: 'RT-STR-05',
    group: 'STR',
    title: 'History DorkOS keeps',
    expected:
      'A runtime whose backend keeps no readable transcript has DorkOS record the turn, so it survives a server restart.',
    flag: flag('logBackedHistory'),
    cells: {
      'claude-code': {
        status: 'n/a',
        reason: 'Claude Code’s own transcript is the history; DorkOS reads it.',
      },
      codex: yes,
      opencode: yes,
      doe: yes,
      'test-mode': yes,
    },
  },
  {
    id: 'RT-STR-06',
    group: 'STR',
    title: 'Honest live status',
    expected:
      'A session reports a running turn while it runs and idle the moment it ends, and a session that never ran reports idle.',
    cells: all(yes),
  },
  {
    id: 'RT-STR-07',
    group: 'STR',
    title: 'A gap-free event stream',
    expected:
      'The durable event stream names the counter it numbers events with, so a reconnect replays from the right place.',
    cells: all(yes),
  },
  {
    id: 'RT-STR-08',
    group: 'STR',
    title: 'Hidden context stays hidden',
    expected:
      'Documents and context attached to a turn reach the agent and never show as the person’s visible message or the agent’s output.',
    cells: all(yes),
  },

  // ── Tools and approvals ─────────────────────────────────────────────────
  {
    id: 'RT-TOOL-01',
    group: 'TOOL',
    title: 'Ask before a tool runs',
    expected:
      'When the permission mode says so, a tool call stops on an approval card and runs only on yes.',
    flag: flag('supportsToolApproval'),
    cells: {
      'claude-code': yes,
      codex: yes,
      opencode: yes,
      doe: yes,
      'test-mode': { status: 'unverified', reason: TEST_FIXTURE },
    },
  },

  // ── Questions ───────────────────────────────────────────────────────────
  {
    id: 'RT-ASK-01',
    group: 'ASK',
    title: 'Ask the person a question',
    expected:
      'The agent can stop and ask the person a question, and an unanswered question says so in history.',
    flag: flag('supportsQuestionPrompt'),
    cells: {
      'claude-code': yes,
      codex: yes,
      opencode: {
        status: 'not-supported',
        reason: 'The OpenCode sidecar has no question tool DorkOS can answer.',
      },
      doe: { status: 'not-supported', reason: 'DorkOS does not expose this feature.' },
      'test-mode': yes,
    },
  },

  // ── Permission modes ────────────────────────────────────────────────────
  {
    id: 'RT-PERM-01',
    group: 'PERM',
    title: 'Declare permission modes honestly',
    expected:
      'Every mode the runtime offers says, in plain words, what it will do without asking, and the default is one of them.',
    cells: all(yes),
  },
  {
    id: 'RT-PERM-02',
    group: 'PERM',
    title: 'A mode set before the first message holds',
    expected:
      'A permission mode sent with a session’s first message is the mode its first turn runs in.',
    cells: all(yes),
  },
  {
    id: 'RT-PERM-03',
    group: 'PERM',
    title: 'Changing a setting says what happened',
    expected:
      'Changing a session’s settings answers whether it applied now or on the next turn, and never claims a session it does not have.',
    cells: all(yes),
  },
  {
    id: 'RT-PERM-04',
    group: 'PERM',
    title: 'Plan mode',
    expected:
      'A read-only planning mode in which nothing changes until the person approves a plan.',
    flag: {
      label: "permissionModes has 'plan'",
      read: (caps) => caps.permissionModes.values.some((mode) => mode.id === 'plan'),
    },
    cells: {
      'claude-code': {
        status: 'unverified',
        reason: 'Declared and offered; no test pins that a plan-mode turn changes nothing.',
      },
      codex: {
        status: 'not-supported',
        reason: 'Codex’s read-only sandbox is its closest mode; it has no plan approval step.',
      },
      opencode: { status: 'not-supported', reason: 'The sidecar has no plan mode.' },
      doe: { status: 'not-supported', reason: 'DorkOS does not expose this feature.' },
      'test-mode': { status: 'n/a', reason: TEST_FIXTURE },
    },
  },

  // ── Models and effort ───────────────────────────────────────────────────
  {
    id: 'RT-MOD-01',
    group: 'MOD',
    title: 'Reasoning effort',
    expected: 'The person’s effort setting reaches the model the turn runs on.',
    flag: { label: 'settings.supportsEffort', read: (caps) => caps.settings.supportsEffort },
    cells: {
      'claude-code': yes,
      codex: yes,
      opencode: {
        status: 'not-supported',
        reason: 'OpenCode has nowhere to spend an effort setting.',
      },
      doe: { status: 'not-supported', reason: 'DorkOS does not expose this feature.' },
      'test-mode': { status: 'n/a', reason: TEST_FIXTURE },
    },
  },

  // ── Accounts and credits ────────────────────────────────────────────────
  {
    id: 'RT-ACCT-01',
    group: 'ACCT',
    title: 'More than one sign-in',
    expected:
      'A session runs and bills on the account it was started on, and the runtime can say which.',
    flag: flag('supportsAccounts'),
    conformance: ['C12'],
    cells: {
      'claude-code': yes,
      codex: { status: 'not-supported', reason: 'Codex uses one sign-in per machine.' },
      opencode: {
        status: 'not-supported',
        reason: 'OpenCode uses one provider setup per machine.',
      },
      doe: { status: 'not-supported', reason: 'DorkOS does not expose this feature.' },
      'test-mode': { status: 'n/a', reason: TEST_FIXTURE },
    },
  },
  {
    id: 'RT-ACCT-02',
    group: 'ACCT',
    title: 'Run on DorkOS credits',
    expected:
      'A session set to credits runs on the credits token, and is refused with nothing started when there is no live token.',
    flag: { label: 'credits', read: (caps) => caps.credits !== undefined },
    cells: {
      'claude-code': yes,
      codex: yes,
      opencode: yes,
      doe: yes,
      'test-mode': { status: 'n/a', reason: TEST_FIXTURE },
    },
  },
  {
    id: 'RT-ACCT-03',
    group: 'ACCT',
    title: 'A sign-in failure is explained',
    expected:
      'When the runtime’s sign-in fails, the person reads it in DorkOS’s words naming the runtime, and it stays an error after a reload.',
    cells: {
      'claude-code': yes,
      codex: yes,
      opencode: yes,
      doe: yes,
      'test-mode': { status: 'n/a', reason: 'It has no sign-in.' },
    },
  },

  // ── MCP ─────────────────────────────────────────────────────────────────
  {
    id: 'RT-MCP-01',
    group: 'MCP',
    title: 'DorkOS’s own tools',
    expected:
      'The agent can use DorkOS’s tools (rooms, relay, tasks, connections) from inside its turn.',
    flag: flag('supportsMcp'),
    cells: {
      'claude-code': yes,
      codex: {
        status: 'not-supported',
        reason: 'Declared off; Codex reaches servers only through its own config.',
      },
      opencode: {
        status: 'not-supported',
        reason: 'Declared off; agent tools are injected into the sidecar instead.',
      },
      doe: yes,
      'test-mode': { status: 'n/a', reason: TEST_FIXTURE },
    },
  },
  {
    id: 'RT-MCP-02',
    group: 'MCP',
    title: 'The person’s MCP servers',
    expected: 'MCP servers the person added in DorkOS are available to the agent.',
    flag: flag('supportsManagedMcpServers'),
    cells: {
      'claude-code': {
        status: 'unverified',
        reason: 'Declared; no test is titled for it yet.',
      },
      codex: { status: 'unverified', reason: 'Declared; no test is titled for it yet.' },
      opencode: { status: 'unverified', reason: 'Declared; no test is titled for it yet.' },
      doe: yes,
      'test-mode': { status: 'n/a', reason: TEST_FIXTURE },
    },
  },

  // ── Plugins, prompts and folders ────────────────────────────────────────
  {
    id: 'RT-PLG-01',
    group: 'PLG',
    title: 'Plugins',
    expected: 'Plugins the person turned on load into the agent’s session.',
    flag: flag('supportsPlugins'),
    cells: {
      'claude-code': yes,
      codex: {
        status: 'not-supported',
        reason: 'Codex has no plugin loader; Harness Sync projects skills instead.',
      },
      opencode: {
        status: 'not-supported',
        reason: 'DorkOS does not load OpenCode plugins; Harness Sync projects skills instead.',
      },
      doe: yes,
      'test-mode': { status: 'n/a', reason: TEST_FIXTURE },
    },
  },
  {
    id: 'RT-PLG-02',
    group: 'PLG',
    title: 'DorkOS’s instructions stay current',
    expected:
      'When the instructions DorkOS adds to the system prompt change, the next turn of a running session gets the new ones.',
    cells: {
      'claude-code': yes,
      codex: yes,
      opencode: yes,
      doe: yes,
      'test-mode': { status: 'unverified', reason: TEST_FIXTURE },
    },
  },
  {
    id: 'RT-PLG-03',
    group: 'PLG',
    title: 'Folder grants',
    expected: 'Each turn reaches exactly the extra folders it was granted, and no others.',
    cells: {
      'claude-code': yes,
      codex: yes,
      opencode: yes,
      doe: yes,
      'test-mode': { status: 'unverified', reason: TEST_FIXTURE },
    },
  },

  // ── Steer, stage and queue ──────────────────────────────────────────────
  {
    id: 'RT-DISP-01',
    group: 'DISP',
    title: 'Steer a running turn',
    expected:
      'A message sent while the agent works reaches it inside the same turn, without starting a new one.',
    flag: flag('supportsSteer'),
    conformance: ['C7'],
    cells: {
      'claude-code': yes,
      codex: yes,
      opencode: {
        status: 'not-supported',
        reason: 'The sidecar takes no input mid-turn; the message waits in the queue.',
      },
      doe: yes,
      'test-mode': yes,
    },
  },
  {
    id: 'RT-DISP-02',
    group: 'DISP',
    title: 'Add context without a reply',
    expected: 'Context the person adds reaches the agent without starting a turn or a reply.',
    flag: flag('supportsContextStaging'),
    conformance: ['C9'],
    cells: {
      'claude-code': yes,
      codex: {
        status: 'not-supported',
        reason: 'Added context is folded into the next message instead.',
      },
      opencode: {
        status: 'not-supported',
        reason: 'Added context is folded into the next message instead.',
      },
      doe: { status: 'not-supported', reason: 'DorkOS does not expose this feature.' },
      'test-mode': yes,
    },
  },
  {
    id: 'RT-DISP-03',
    group: 'DISP',
    title: 'The queue keeps order',
    expected:
      'Each turn window ends with exactly one `done`, and a queued message runs after a failed turn but never into an open question or approval.',
    conformance: ['C2', 'C3'],
    cells: all(yes),
  },
  {
    id: 'RT-DISP-04',
    group: 'DISP',
    title: 'An unsupported way of sending is refused cleanly',
    expected:
      'A steer or stage the runtime does not declare is refused as unsupported, never thrown.',
    conformance: ['C1'],
    cells: all(yes),
  },

  // ── Stopping a turn ─────────────────────────────────────────────────────
  {
    id: 'RT-STOP-01',
    group: 'STOP',
    title: 'Stop is safe with nothing running',
    expected:
      'Stopping a session with no turn open, or one the runtime never saw, answers “not running” and never fails.',
    conformance: ['I1', 'I5'],
    cells: all(yes),
  },
  {
    id: 'RT-STOP-02',
    group: 'STOP',
    title: 'Stopping a live turn answers honestly',
    expected:
      'Stopping a running turn returns a receipt naming the runtime and the outcome, within a bound even when the backend never answers.',
    conformance: ['I2', 'C11'],
    cells: all(yes),
  },

  // ── Background work and turn lifecycle ──────────────────────────────────
  {
    id: 'RT-LIFE-01',
    group: 'LIFE',
    title: 'Keep the agent warm between turns',
    expected:
      'The agent’s process stays open between turns, reports idle while it waits, and a reaped process is invisible to the next turn.',
    flag: flag('supportsPersistentSession'),
    conformance: ['C4', 'C5'],
    cells: {
      'claude-code': yes,
      codex: yes,
      opencode: {
        status: 'not-supported',
        reason: 'The sidecar is shared; DorkOS holds no per-session process.',
      },
      doe: { status: 'not-supported', reason: 'DorkOS does not expose this feature.' },
      'test-mode': yes,
    },
  },
  {
    id: 'RT-LIFE-02',
    group: 'LIFE',
    title: 'Settle an open turn',
    expected:
      'Asking a warm session to settle answers honestly when nothing is open, and never throws.',
    flag: flag('supportsPersistentSession'),
    conformance: ['C8'],
    cells: {
      'claude-code': yes,
      codex: yes,
      opencode: { status: 'n/a', reason: 'It keeps no warm process to settle.' },
      doe: { status: 'not-supported', reason: 'DorkOS does not expose this feature.' },
      'test-mode': yes,
    },
  },
  {
    id: 'RT-LIFE-03',
    group: 'LIFE',
    title: 'Work that outlives the turn wakes the chat',
    expected:
      'A background shell or helper that finishes after the turn ended delivers its result into the chat as a new turn, as it does in the runtime’s own CLI.',
    cells: {
      'claude-code': {
        status: 'partial',
        reason:
          'Helpers report back on a warm session; background shells, timers and hooks do not yet.',
        ticket: 'DOR-2717',
      },
      codex: {
        status: 'partial',
        reason:
          'Background commands wake the chat; a helper agent that outlives its turn is tracked but not yet proven against Codex.',
        evidence: U,
        ticket: 'DOR-2717',
      },
      opencode: {
        status: 'planned',
        reason: 'Nothing delivers work that finishes after an OpenCode turn.',
        ticket: 'DOR-2717',
      },
      doe: {
        status: 'not-supported',
        reason: 'Builder work stays owned by its turn; detached completion is not offered.',
      },
      'test-mode': { status: 'n/a', reason: TEST_FIXTURE },
    },
  },

  // ── Attachments and media ───────────────────────────────────────────────
  {
    id: 'RT-MEDIA-01',
    group: 'MEDIA',
    title: 'Attach images to a message',
    expected: 'Images the person attaches reach the agent with the message.',
    cells: {
      'claude-code': yes,
      codex: yes,
      opencode: {
        status: 'unverified',
        reason: 'Not proven by a test titled for it.',
      },
      doe: { status: 'not-supported', reason: 'Images cannot be attached to Doe messages yet.' },
      'test-mode': { status: 'n/a', reason: TEST_FIXTURE },
    },
  },
  {
    id: 'RT-MEDIA-02',
    group: 'MEDIA',
    title: 'Pictures the agent makes',
    expected:
      'An image the agent produces reaches the chat as a picture, announced by reference rather than as bytes on the stream.',
    flag: { label: "mediaOutput !== 'none'", read: (caps) => caps.mediaOutput !== 'none' },
    cells: {
      'claude-code': {
        status: 'not-supported',
        reason: 'Declared none; tool images are captured but not announced as output.',
      },
      codex: { status: 'not-supported', reason: 'Declared none.' },
      opencode: { status: 'not-supported', reason: 'Declared none.' },
      doe: { status: 'not-supported', reason: 'DorkOS does not expose this feature.' },
      'test-mode': { status: 'n/a', reason: TEST_FIXTURE },
    },
  },

  // ── Cost and usage ──────────────────────────────────────────────────────
  {
    id: 'RT-COST-01',
    group: 'COST',
    title: 'Cost and usage per turn',
    expected:
      'Each turn reports the tokens it used, and its cost where the account pays per token.',
    flag: flag('supportsCostTracking'),
    cells: {
      'claude-code': yes,
      codex: {
        status: 'not-supported',
        reason: 'Declared off; Codex reports context use but not cost.',
      },
      opencode: yes,
      doe: yes,
      'test-mode': { status: 'n/a', reason: TEST_FIXTURE },
    },
  },

  // ── Compaction ──────────────────────────────────────────────────────────
  {
    id: 'RT-CMP-01',
    group: 'CMP',
    title: 'Compact the conversation',
    expected:
      'The person can ask for the conversation to be compacted, and progress is reported while it runs.',
    flag: {
      label: 'commandIntents.compact',
      read: (caps) => caps.commandIntents.compact?.supported === true,
    },
    cells: {
      'claude-code': yes,
      // On app-server, the default transport: `thread/compact/start`. On exec
      // (`runtimes.codex.transport: exec`) Codex only runs prompts, and the
      // flag is false there.
      codex: yes,
      opencode: yes,
      doe: yes,
      'test-mode': yes,
    },
  },
  {
    id: 'RT-CMP-02',
    group: 'CMP',
    title: 'The agent can ask for its own conversation to be compacted',
    expected:
      'An agent asks for its own conversation to be summarized; it runs after the turn ends, and the chat says the agent asked. Its focus note is used where the runtime takes one (Claude Code).',
    flag: {
      label: 'commandIntents.compact',
      read: (caps) => caps.commandIntents.compact?.supported === true,
    },
    cells: {
      'claude-code': yes,
      // Codex and OpenCode take no focus note; the row says so rather than
      // marking the same summary partial on one runtime and whole on another.
      codex: yes,
      opencode: yes,
      doe: yes,
      'test-mode': yes,
    },
  },
  {
    id: 'RT-CMP-03',
    group: 'CMP',
    title: 'Report how full the conversation is',
    expected:
      'After each reply the runtime reports the tokens in the context and the size of the window, so DorkOS can tell the agent when it passes 80%. A model whose window the runtime cannot learn reports no window rather than a guess.',
    // Codex's column is app-server; on exec the reading comes from the turn's
    // rollout file. OpenCode's window comes from its sidecar's model catalog,
    // since its usage event names none.
    cells: all(yes),
  },
];

/** What to call a status in the doc. */
const STATUS_MARK: Readonly<Record<CellStatus, string>> = {
  supported: 'yes',
  partial: 'partial',
  unverified: 'unverified',
  planned: 'planned',
  'not-supported': 'no',
  'n/a': 'n/a',
};

/** One cell as the matrix table shows it. */
function cellText(cell: MatrixCell): string {
  const proof = cell.evidence?.length ? ` (${cell.evidence.join(', ')})` : '';
  const ticket = cell.ticket ? ` ${cell.ticket}` : '';
  return `${STATUS_MARK[cell.status]}${proof}${ticket}`;
}

/** Escapes a table cell. */
function md(text: string): string {
  return text.replace(/\|/g, '\\|');
}

/**
 * Renders `contributing/capabilities/runtimes.md` from the registry.
 *
 * Deterministic and dependency-free, so the census can compare the committed
 * file to it byte for byte.
 *
 * @param rows - The capabilities to render; the registry by default.
 * @returns The document's full text.
 */
export function renderRuntimeCapabilityMatrix(
  rows: readonly RuntimeCapability[] = RUNTIME_CAPABILITIES
): string {
  const out: string[] = [];
  const header = `| ID | Capability | ${MATRIX_RUNTIMES.join(' | ')} |`;
  const rule = `| --- | --- | ${MATRIX_RUNTIMES.map(() => '---').join(' | ')} |`;

  out.push(
    '<!-- Generated from packages/test-utils/src/runtime-capability-matrix.ts by `pnpm docs:runtime-capabilities`. Do not edit by hand. -->',
    '',
    '# Runtime capabilities',
    '',
    'What every agent runtime DorkOS runs should do, and how far each one gets. This is the list of what runtimes **should** do, not only what is built: a capability nobody has built yet enters as a row marked `planned`, with the ticket that will build it.',
    '',
    'To add a capability, add a row to `packages/test-utils/src/runtime-capability-matrix.ts` and run `pnpm docs:runtime-capabilities`. The census (`apps/server/src/services/runtimes/__tests__/runtime-capability-census.test.ts`) then checks it.',
    '',
    '**Statuses:** `yes` does what the row says. `partial` does some of it. `unverified` says it does and no test proves it yet. `planned` will, under the named ticket. `no` does not, and nothing is planned. `n/a` does not apply.',
    '',
    '**Proof:** `U` a deterministic CI test (the shared conformance suite against a mocked backend, or the runtime’s own tests). `E` a browser test on test-mode. `L` a live run against the real backend. Only `L` cells may be claimed in public copy.',
    '',
    '**The census checks** that every `U` claim has a test whose title starts with the row id (or a conformance id the row lists) in a test that runs for that runtime; that no test names an unknown id; that no runtime-specific test claims a cell marked `planned`, `no` or `n/a`; that a row with a declared flag agrees with each runtime’s declared capabilities; and that this file matches the registry.',
    '',
    '`test-mode` is the scripted fixture runtime the browser tests use, not a product runtime.',
    ''
  );

  out.push('## Parity', '', `| Runtime | yes | partial | unverified | planned | no | n/a |`);
  out.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const runtime of MATRIX_RUNTIMES) {
    const count = (status: CellStatus) =>
      rows.filter((row) => row.cells[runtime].status === status).length;
    out.push(
      `| ${runtime} | ${count('supported')} | ${count('partial')} | ${count('unverified')} | ${count('planned')} | ${count('not-supported')} | ${count('n/a')} |`
    );
  }
  out.push('');

  for (const [group, heading] of Object.entries(MATRIX_GROUPS)) {
    const inGroup = rows.filter((row) => row.group === group);
    if (inGroup.length === 0) continue;
    out.push(`## ${heading}`, '', header, rule);
    for (const row of inGroup) {
      out.push(
        `| ${row.id} | ${md(row.title)} | ${MATRIX_RUNTIMES.map((runtime) => md(cellText(row.cells[runtime]))).join(' | ')} |`
      );
    }
    out.push('');
    for (const row of inGroup) {
      const sources = [
        row.flag ? `flag \`${row.flag.label}\`` : null,
        row.conformance?.length ? `conformance ${row.conformance.join(', ')}` : null,
      ].filter(Boolean);
      out.push(
        `- **${row.id}** ${md(row.expected)}${sources.length ? ` _(${sources.join('; ')})_` : ''}`
      );
    }
    out.push('');
  }

  out.push(
    '## Gaps',
    '',
    'Every cell that is not `yes`, `no` or `n/a`, planned work first.',
    '',
    '| ID | Runtime | Status | Ticket | Why |',
    '| --- | --- | --- | --- | --- |'
  );
  const order: readonly CellStatus[] = ['planned', 'partial', 'unverified'];
  for (const status of order) {
    for (const row of rows) {
      for (const runtime of MATRIX_RUNTIMES) {
        const cell = row.cells[runtime];
        if (cell.status !== status) continue;
        out.push(
          `| ${row.id} | ${runtime} | ${STATUS_MARK[status]} | ${cell.ticket ?? ''} | ${md(cell.reason ?? '')} |`
        );
      }
    }
  }
  out.push('');
  return out.join('\n');
}
