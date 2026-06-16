/**
 * Runtime-neutral additional-context model (ADR-0273).
 *
 * The canonical, backend-agnostic representation of per-turn context DorkOS
 * attaches to a message. Entries carry STRUCTURED `data` — never pre-formatted
 * prose — so any runtime adapter can render them in whatever shape its backend
 * expects. The server owns WHAT context exists (the assembler); each adapter
 * owns HOW it is rendered (e.g. the Claude adapter's `renderContextEntry`).
 *
 * Two layers exist:
 * - {@link ClientContext}: the thin client-sourced signal bag (ui_state, queued)
 *   sent on the wire. The client contributes only what it knows.
 * - {@link AdditionalContext}: the server-assembled, fully-derived entry list the
 *   runtime receives. The server derives git_status/env and normalizes the
 *   client signals into discriminated {@link AdditionalContextEntry} members.
 *
 * @module shared/additional-context
 */
import { z } from 'zod';
import { UiStateSchema, type UiState } from './schemas.js';

/** Kinds of additional context DorkOS can attach to a turn. */
export type ContextKind = 'git_status' | 'ui_state' | 'queue_note' | 'env' | 'relay_context';

/** Lifetime of an entry — informs adapter placement, not yet load-bearing. */
export type ContextScope = 'per-turn' | 'per-session';

/**
 * Structured git status the server derives once (in the assembler) and the
 * adapter formats. Modeled on the fields the legacy `buildGitBlock` consumed
 * from `GitStatusResponse`. For a non-git directory only `isRepo: false` is set.
 */
export interface GitStatusData {
  /** Whether `cwd` is inside a git repository. */
  isRepo: boolean;
  /** Current branch name (or HEAD SHA when detached). */
  branch?: string;
  /** Commits ahead of the remote tracking branch. */
  ahead?: number;
  /** Commits behind the remote tracking branch. */
  behind?: number;
  /** Whether HEAD is detached. */
  detached?: boolean;
  /** Whether the working tree is clean. */
  clean?: boolean;
  /** Count of modified files (staged + unstaged). */
  modified?: number;
  /** Count of staged files. */
  staged?: number;
  /** Count of untracked files. */
  untracked?: number;
  /** Count of files with merge conflicts. */
  conflicted?: number;
}

/**
 * Stable environment metadata the server can attach as a per-session entry.
 * Mirrors the fields the Claude adapter's `buildEnvBlock` renders.
 *
 * NOTE (ADR-0273 G2): env currently flows via `systemPrompt.append`, NOT this
 * entry — the assembler does not emit an `env` entry today. The kind/type are
 * retained so a future runtime that cannot suppress its preset env block can
 * carry env through the bag instead.
 */
export interface EnvData {
  /** Working directory for the session. */
  workingDirectory: string;
  /** Product name (e.g. "DorkOS"). */
  product: string;
  /** Server version string. */
  version: string;
  /** API port the server listens on. */
  port: number;
  /** Host platform (`os.platform()`). */
  platform: string;
  /** OS release string (`os.release()`). */
  osVersion: string;
  /** Node.js runtime version (`process.version`). */
  nodeVersion: string;
  /** Host machine name (`os.hostname()`). */
  hostname: string;
}

/**
 * Relay metadata that today wraps the `<relay_context>` block (sender, budget,
 * reply routing). Retained as a typed hook so the assembler can carry relay
 * context through the bag in future; relay delivery currently builds its own
 * block in `@dorkos/relay` and does NOT flow through the assembler.
 */
export interface RelayContextData {
  /** The recipient agent's id. */
  agentId: string;
  /** The backend session id the relay message resumed. */
  sessionId: string;
  /** Sender endpoint subject. */
  from: string;
  /** Relay message id. */
  messageId: string;
  /** Subject the message was sent on. */
  subject: string;
  /** ISO timestamp the message was created. */
  sent: string;
  /** Hops used out of the budget maximum. */
  hopsUsed?: number;
  /** Hop budget maximum. */
  hopsMax?: number;
  /** Seconds of TTL remaining. */
  ttlSecondsRemaining?: number;
  /** Remaining call/turn budget. */
  callBudgetRemaining?: number;
  /** Reply-to endpoint subject, when a reply is expected. */
  replyTo?: string;
}

/**
 * Discriminated union of the canonical server-assembled entries. Each member
 * pairs a {@link ContextKind} with its structured `data` payload and a
 * {@link ContextScope}.
 */
export type AdditionalContextEntry =
  | { kind: 'git_status'; scope: 'per-turn'; data: GitStatusData }
  | { kind: 'ui_state'; scope: 'per-turn'; data: UiState }
  | { kind: 'queue_note'; scope: 'per-turn'; data: { composedDuringPrevTurn: true } }
  | { kind: 'env'; scope: 'per-session'; data: EnvData }
  | { kind: 'relay_context'; scope: 'per-turn'; data: RelayContextData };

/** The per-turn bag a runtime receives via `MessageOpts.additionalContext`. */
export type AdditionalContext = AdditionalContextEntry[];

/**
 * Client-sourced signals. The client contributes only what it knows; the
 * SERVER derives git_status/env and normalizes everything into entries.
 * Signals + data only — NEVER pre-formatted prose.
 */
export interface ClientContext {
  /** Snapshot of the client UI state for agent situational awareness. */
  uiState?: UiState;
  /** True when composed while the agent was responding to the previous turn. */
  queued?: boolean;
  // room for: editorSelection, openFile, …
}

/**
 * XML wrapper tag per kind — the SINGLE source of truth for tag names, used by
 * BOTH the adapter formatter (`renderContextEntry`) and the render-strip
 * (`stripSystemTags`). Keying both off this map makes drift impossible: adding
 * a {@link ContextKind} extends this map and both sides pick it up automatically.
 */
export const CONTEXT_TAG = {
  git_status: 'git_status',
  ui_state: 'ui_state',
  queue_note: 'queue_note',
  env: 'env',
  relay_context: 'relay_context',
} satisfies Record<ContextKind, string>;

/** Zod schema for {@link GitStatusData}. */
export const GitStatusDataSchema = z.object({
  isRepo: z.boolean(),
  branch: z.string().optional(),
  ahead: z.number().int().optional(),
  behind: z.number().int().optional(),
  detached: z.boolean().optional(),
  clean: z.boolean().optional(),
  modified: z.number().int().optional(),
  staged: z.number().int().optional(),
  untracked: z.number().int().optional(),
  conflicted: z.number().int().optional(),
});

/** Zod schema for {@link EnvData}. */
export const EnvDataSchema = z.object({
  workingDirectory: z.string(),
  product: z.string(),
  version: z.string(),
  port: z.number(),
  platform: z.string(),
  osVersion: z.string(),
  nodeVersion: z.string(),
  hostname: z.string(),
});

/** Zod schema for {@link RelayContextData}. */
export const RelayContextDataSchema = z.object({
  agentId: z.string(),
  sessionId: z.string(),
  from: z.string(),
  messageId: z.string(),
  subject: z.string(),
  sent: z.string(),
  hopsUsed: z.number().int().optional(),
  hopsMax: z.number().int().optional(),
  ttlSecondsRemaining: z.number().int().optional(),
  callBudgetRemaining: z.number().int().optional(),
  replyTo: z.string().optional(),
});

/** Zod schema for {@link AdditionalContextEntry} (discriminated on `kind`). */
export const AdditionalContextEntrySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('git_status'),
    scope: z.literal('per-turn'),
    data: GitStatusDataSchema,
  }),
  z.object({
    kind: z.literal('ui_state'),
    scope: z.literal('per-turn'),
    data: z.lazy(() => UiStateSchema),
  }),
  z.object({
    kind: z.literal('queue_note'),
    scope: z.literal('per-turn'),
    data: z.object({ composedDuringPrevTurn: z.literal(true) }),
  }),
  z.object({
    kind: z.literal('env'),
    scope: z.literal('per-session'),
    data: EnvDataSchema,
  }),
  z.object({
    kind: z.literal('relay_context'),
    scope: z.literal('per-turn'),
    data: RelayContextDataSchema,
  }),
]);

/** Zod schema for {@link AdditionalContext}. */
export const AdditionalContextSchema = z.array(AdditionalContextEntrySchema);

/**
 * Zod schema for {@link ClientContext}. Strict-ish: only `uiState` and `queued`
 * are accepted (extra keys are stripped by Zod's default object parsing).
 */
export const ClientContextSchema = z.object({
  uiState: z.lazy(() => UiStateSchema).optional(),
  queued: z.boolean().optional(),
});
