/**
 * The one probe for "does this room binding still have its conversation on
 * disk" (DOR-805).
 *
 * A room binds one session per agent (`room_sessions`), and that binding is what
 * makes an agent in a room remember yesterday. Two things ask whether the
 * binding still points at something: the boot-time convergence sweep
 * (`room-session-convergence.ts`), which repairs or reports what it finds, and
 * the deep health check behind `dorkos doctor --deep`
 * (`services/observability/deep-health/`), which tells a person about it. They
 * used to ask in two different ways and could therefore disagree, which is the
 * one thing two answers to the same question must never do:
 *
 * - **The doctor swept every slug folder** under every Claude account's
 *   `projects/` and matched on the session id alone. An agent whose project
 *   directory has since moved still has its old transcript filed under the OLD
 *   directory's slug, so the doctor found it and passed — while a resume, which
 *   looks under the slug of the directory the agent is in NOW, finds nothing.
 *   The room really had lost its memory and the doctor said it had not.
 * - **The two disagreed about which runtime owns a binding.** The sweep read the
 *   agent's manifest (a preference about the NEXT session it starts); the doctor
 *   read the session's own owner, falling back to a blind "claude-code" for any
 *   session nothing has bound — which is every room placeholder. So an agent
 *   whose manifest changed after its session started was skipped by one and
 *   warned about by the other.
 *
 * So both consumers call {@link probeRoomBindingTranscript}, and it asks the
 * question the way a resume asks it: the cwd-scoped transcript probe, gated by
 * {@link resolveTurnRuntimeType} — the session's bound owner where there is one,
 * and only otherwise the manifest (ADR-0255).
 *
 * Nothing here reads a disk directly. The transcript probe is injected, exactly
 * as the sweep already injected it, so neither caller reaches into a runtime's
 * internals for it.
 *
 * @module server/services/rooms/session-bindings/room-binding-transcripts
 */
import { resolveTurnRuntimeType } from '../../runtimes/shared/resolve-agent-runtime-type.js';
import type { RoomSessionBinding } from './room-session-ledger.js';

/** The runtime whose sessions keep a transcript file, and the only one to probe. */
const CLAUDE_CODE_RUNTIME = 'claude-code';

/** What the probe needs from the world, so a test can supply all of it. */
export interface RoomBindingTranscriptDeps {
  /**
   * The agent directory behind a room author id, or `null` when the author is
   * not an agent this install knows. Both callers ask the author registry for
   * `naturalKey`, exactly as the dispatcher does.
   *
   * May throw, and is expected to: in production this is a synchronous
   * better-sqlite3 read, which raises on a busy, corrupt or closed database.
   * {@link probeRoomBindingTranscript} contains it — see its doc for why that
   * matters more here than the synchronous signature suggests.
   */
  agentPathFor(authorId: string): string | null;
  /**
   * Whether a transcript for this session exists on disk under this agent's
   * working directory — the claude-code transcript probe, injected rather than
   * imported.
   */
  hasTranscript(agentPath: string, sessionId: string): Promise<boolean>;
}

/**
 * One binding's answer, carrying exactly what that verdict makes available.
 *
 * A union rather than one optional-everything shape, because the two things a
 * caller reaches for are only there on some branches: there is no agent path
 * for an author that is not an agent, and no error for a probe that answered.
 */
export type RoomBindingTranscriptAnswer =
  /** Not a question about this binding: an unknown author, or a runtime that keeps no transcript. */
  | {
      verdict: 'not-applicable';
      /** `null` when the author is not an agent this install knows. */
      agentPath: string | null;
    }
  /** `present` — the conversation is where a resume would look for it; `missing` — it is not, so this agent would start over in this room. */
  | { verdict: 'present' | 'missing'; agentPath: string }
  /**
   * Nothing could be learned either way — the agent lookup, the runtime read or
   * the transcript read failed.
   *
   * `agentPath` is `null` when it was the LOOKUP that failed, because resolving
   * it is the thing that did not happen. Both callers narrow to `present` or
   * `missing` before reading it, so this widening costs them nothing.
   */
  | { verdict: 'unreadable'; agentPath: string | null; error: string };

/**
 * Ask whether one room binding still has its conversation on disk.
 *
 * **Never throws — all three reads included.** A failed transcript read, a
 * failed runtime read and a failed AGENT LOOKUP all come back as `unreadable`,
 * because "nothing is known about this binding" and "nothing is wrong with this
 * binding" are opposite answers and a caller that cannot tell them apart
 * reports a clean bill of health for a machine whose `~/.claude/projects` has
 * gone unreadable.
 *
 * The agent lookup used to sit outside the guard, on the reasoning that it is a
 * synchronous map read. It is not: in production it is `roomAuthors.getById`,
 * a synchronous better-sqlite3 `.get()` that throws on `SQLITE_BUSY`, a corrupt
 * file, or a closed handle — the exact conditions under which somebody runs
 * `dorkos debug room` in the first place. One unreadable author row cost the
 * caller its whole report: the survey behind `dorkos doctor --deep` aborted
 * mid-sweep, and the debug endpoint answered `500` carrying the raw error
 * message, which on this path carries an absolute path across a boundary that
 * is not allowed to see one (DOR-1780).
 *
 * There is no `agentPath` to report on that branch — resolving it is what
 * failed — so it travels as `null`, the same shape the not-an-agent case uses.
 *
 * @param binding - The row to judge.
 * @param deps - The agent lookup and the transcript probe.
 * @returns The verdict, the agent path behind it, and the error when there is one.
 */
export async function probeRoomBindingTranscript(
  binding: RoomSessionBinding,
  deps: RoomBindingTranscriptDeps
): Promise<RoomBindingTranscriptAnswer> {
  let agentPath: string | null;
  try {
    agentPath = deps.agentPathFor(binding.authorId);
  } catch (err) {
    return { verdict: 'unreadable', agentPath: null, error: describe(err) };
  }
  if (agentPath === null) return { verdict: 'not-applicable', agentPath: null };

  let runtime: string;
  try {
    runtime = await resolveTurnRuntimeType({ sessionId: binding.sessionId, agentPath });
  } catch (err) {
    return { verdict: 'unreadable', agentPath, error: describe(err) };
  }
  // Only claude-code writes a transcript file. A Codex or OpenCode session has
  // none by design, so calling one of those missing would be a false alarm.
  if (runtime !== CLAUDE_CODE_RUNTIME) return { verdict: 'not-applicable', agentPath };

  try {
    const exists = await deps.hasTranscript(agentPath, binding.sessionId);
    return { verdict: exists ? 'present' : 'missing', agentPath };
  } catch (err) {
    return { verdict: 'unreadable', agentPath, error: describe(err) };
  }
}

/** What one pass over a whole table of bindings found. */
export interface RoomBindingTranscriptSurvey {
  /** How many bindings the probe reached a verdict on — `present` plus `missing`. */
  judged: number;
  /** The bindings pointing at a conversation that is not on disk. */
  missing: RoomSessionBinding[];
  /** How many bindings nothing could be learned about. */
  unreadable: number;
}

/**
 * Run {@link probeRoomBindingTranscript} over every binding and total up the
 * answers — what the deep health check reads.
 *
 * Sequential on purpose: this walks a disk on behalf of a report somebody is
 * reading during an incident, and a burst of parallel `readdir`s on an install
 * with hundreds of bindings buys nothing worth the load.
 *
 * @param bindings - Every row of `room_sessions`.
 * @param deps - The agent lookup and the transcript probe.
 * @returns The counts, plus the bindings that have lost their conversation.
 */
export async function surveyRoomBindingTranscripts(
  bindings: readonly RoomSessionBinding[],
  deps: RoomBindingTranscriptDeps
): Promise<RoomBindingTranscriptSurvey> {
  const survey: RoomBindingTranscriptSurvey = { judged: 0, missing: [], unreadable: 0 };
  for (const binding of bindings) {
    const { verdict } = await probeRoomBindingTranscript(binding, deps);
    if (verdict === 'unreadable') survey.unreadable += 1;
    if (verdict === 'present' || verdict === 'missing') survey.judged += 1;
    if (verdict === 'missing') survey.missing.push(binding);
  }
  return survey;
}

/** The message of whatever was thrown, for a log line. */
function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
