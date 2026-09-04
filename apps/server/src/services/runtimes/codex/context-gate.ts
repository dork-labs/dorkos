/**
 * Which half of the runtime-neutral DorkOS context a Codex turn has to carry
 * (DOR-477).
 *
 * ## Why Codex needs a gate and the other two runtimes do not
 *
 * claude-code puts this content in `systemPrompt.append`, which is cacheable and
 * belongs to the launched process rather than to the transcript. OpenCode puts it
 * on `session.promptAsync`'s `body.system`, which the sidecar re-reads per request
 * and never persists as a message. Codex exec has NEITHER: `ThreadOptions` carries
 * no system-prompt field at 0.147.0, so the only input channel is the prompt string
 * — and a prompt string lands in the thread's persisted rollout.
 *
 * That is what makes repetition expensive here rather than merely wasteful. Sending
 * the identity blocks on every turn does not send one copy per turn; it leaves one
 * copy per turn IN the conversation, so turn N pays for all N of them.
 *
 * **The numbers below are BYTES of the assembled prefix, not provider tokens.**
 * They were taken by running the real builder over the real DorkBot workspace
 * (SOUL.md 992 B, NOPE.md 452 B, MEMORY.md 941 B) and measuring the strings it
 * produced — not by summing file sizes, and not by counting what a provider
 * billed, which no test here may spend to find out. Quote them as bytes. The
 * REDUCTION ratio does carry over to tokens, and only because of what is being
 * removed: the deduplicated content is byte-identical repetition of one string,
 * so whatever it tokenizes to, it tokenizes to the same thing every time.
 *
 * On that basis the stable half is 3,961 B and the memory block 1,997 B. (DOR-477
 * estimated the block at ~2.2 KB from file sizes alone; the real figure is higher
 * because `<session_model>`, `<user_profile>` and `<env>` are in it too.) Across a
 * 20-turn thread the cumulative injected prefix falls from 1,251,600 B to
 * 498,630 B — about 60% of it was the same bytes over and over.
 *
 * ## What "once" means here, precisely
 *
 * Once per (session, content) pair, per server process. The gate remembers a digest
 * of the STABLE half of the append and re-sends the whole thing whenever that digest
 * is new to it — which happens on a session's first turn, after a server restart, and
 * whenever the agent itself is edited. Everything else (the agent's own memory, the
 * room-tool menu) is deliberately outside the gate and rides every turn, because it
 * changes while the thread runs.
 *
 * Three deliberate consequences, each the cheap side of a trade:
 *
 * - **The digest is taken over `stable`, never `text`.** `stable` is assembled
 *   without the agent-written memory block rather than sliced out of it — see
 *   `shared/agent-context.ts`, which explains at length why agent-written bytes
 *   must never be able to move a digest boundary. The same rule holds here.
 * - **A restart re-sends once.** Held in memory rather than in the `codex_threads`
 *   row, so the first turn after a restart re-anchors the thread. That is a feature
 *   as much as a limitation: Codex compacts long threads on its own, and a
 *   compaction can summarize the original prompt away. Re-anchoring is the only
 *   repair the adapter has.
 * - **Nothing is recorded until the prompt is actually dispatched.** {@link select}
 *   hands back a `commit` the caller runs after `runStreamed` resolves. Recording at
 *   selection time would let a turn that threw on the way to Codex convince the next
 *   turn that a thread already holds context it never received.
 *
 * @module services/runtimes/codex/context-gate
 */
import { createHash } from 'node:crypto';
import type { AgentContextAppend } from '../shared/agent-context.js';

/** What one turn should carry, and how to record that it carried it. */
export interface CodexContextSelection {
  /** The neutral context this turn sends — the whole append, or memory alone. */
  readonly text: string;
  /**
   * Record that this turn's prompt reached Codex. Call it AFTER the prompt was
   * dispatched, never before; a turn that fails on the way out must leave the
   * gate exactly as it found it.
   */
  readonly commit: () => void;
}

/**
 * Per-session memory of the DorkOS context each Codex thread already holds.
 *
 * One instance per {@link CodexRuntime}; not shared, not persisted. See the
 * module docblock for what "already holds" is allowed to mean.
 *
 * It keeps one 64-character digest per session the process has taken a turn for
 * and never evicts, which is deliberate: eviction is indistinguishable from
 * "this thread was never told", so the only thing forgetting can cost is a
 * re-anchor — and the alternative, a size cap, would spend that cost silently on
 * whichever session happened to fall out. A few kilobytes for a busy day is the
 * cheaper side of that trade.
 */
export class CodexContextGate {
  /** sessionId → digest of the stable append that session's thread was last sent. */
  private readonly sent = new Map<string, string>();

  /**
   * Decide what one turn's neutral context should be.
   *
   * @param sessionId - DorkOS session identifier (one session ↔ one Codex thread)
   * @param append - This turn's freshly built runtime-neutral append
   * @returns The text to send, and the `commit` to run once it was dispatched
   */
  select(sessionId: string, append: AgentContextAppend): CodexContextSelection {
    const digest = createHash('sha256').update(append.stable).digest('hex');
    // The stable half is already in the thread — send only what changes.
    if (this.sent.get(sessionId) === digest) {
      return { text: append.memory, commit: () => {} };
    }
    return {
      text: append.text,
      commit: () => {
        this.sent.set(sessionId, digest);
      },
    };
  }

  /**
   * Forget what a session's thread holds, so its next turn re-anchors.
   *
   * Called whenever a turn is about to START a thread rather than resume one: a
   * fresh thread holds nothing, whatever its predecessor was sent. That also
   * covers the first turn that crashed before `thread.started` — no binding was
   * persisted, so the retry starts a thread too, and is re-anchored here.
   *
   * @param sessionId - DorkOS session identifier
   */
  forget(sessionId: string): void {
    this.sent.delete(sessionId);
  }
}
