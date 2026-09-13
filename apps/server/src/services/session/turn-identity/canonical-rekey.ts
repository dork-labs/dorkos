/**
 * Following a session to the id its runtime decides to call it.
 *
 * The claude-code SDK mints its OWN session id on the first turn and renames the
 * session to it mid-stream. Everything a turn holds is keyed by session id — the
 * projector, the turn chain, the write-lock, the durable event rows — so a
 * rename that nothing follows leaves a session answering under one id while its
 * state lives under another: a client that reads the canonical id off its 202
 * finds a fresh empty projector, and its next message starts a SECOND stream
 * into the projector the first turn is still writing to.
 *
 * This is the one implementation of "follow it", shared by every path that opens
 * a turn — `triggerTurn` for a person's message, and the task scheduler for an
 * attended run. It lived as a closure inside `triggerTurn` while that was the
 * only path; the run path then grew one too and had none of it, which is the
 * bug this module exists to make unrepeatable.
 *
 * ## Why it RETRIES rather than reads once
 *
 * The adapter's reverse-index remap is driven by the SDK's init message and is
 * not guaranteed to have run by the first yielded event — observed live
 * (acceptance run 20260610-173202, F2): a one-shot read raced the init and the
 * projector stayed keyed by the request id for the whole first turn. So the
 * caller retries on every event until a canonical id DIFFERENT from the request
 * id appears.
 *
 * Identity must NOT disarm the retry (acceptance run 20260611-145454): the
 * claude-code adapter SEEDS `sdkSessionId === sessionId` at `ensureSession`
 * time, so the first yield always sees a truthy identity mapping before the init
 * assigns the real id. A genuinely-identity session (the resume path) simply
 * keeps the retry armed all turn — one map lookup per event, harmless.
 *
 * Its own directory because the concern is a seam, not a file: "which id does
 * this turn hold its state under, and what has to move when the runtime changes
 * its mind" is asked by every path that opens a turn, and `services/session` is
 * at the file count the project-structure guard blocks on.
 *
 * @module services/session/turn-identity/canonical-rekey
 */
import type { SseResponse } from '@dorkos/shared/agent-runtime';

/**
 * The part of a turn chain a rekey touches.
 *
 * A port rather than an import of the queue itself, so this module can be used
 * by the queue's own owner (`trigger-turn.ts`) without a cycle.
 */
export interface TurnChainLink {
  /** Point a newly-learned id at the chain an existing id is filed under. */
  link(aliasId: string, primaryId: string): void;
}

/** The runtime seams a rekey needs. Every `AgentRuntime` satisfies it. */
export interface CanonicalRekeyPort {
  /** The runtime's own id for a session key, once it has minted or kept one. */
  getInternalSessionId(sessionId: string): string | undefined;
  /** Move the session's projector (and every store keyed with it) to a new id. */
  rekeyProjector(oldId: string, newId: string): void;
  /** Take the session write-lock under an id. */
  acquireLock(sessionId: string, clientId: string, res: SseResponse, token?: symbol): boolean;
  /** Give back a lock this holder took. */
  releaseLock(sessionId: string, clientId: string, token?: symbol): void;
}

/** What a caller must tell this module about the turn it is running. */
export interface CanonicalRekeyOpts {
  /** The id the turn was ASKED with — what the runtime's wiring is filed under. */
  sessionId: string;
  /** The lock identity holding the turn. */
  clientId: string;
  /** The lifecycle the lock is bound to. */
  holder: SseResponse;
  /** This turn's lock token, so a move re-acquires as the same turn. */
  lockToken: symbol;
  /** The runtime seams. */
  deps: CanonicalRekeyPort;
  /** The turn chain this turn reserved its slot from. */
  chain: TurnChainLink;
  /** The id this turn currently holds its lock and chain under. */
  turnKey: () => string;
  /** Called when the lock and chain have moved, so the caller follows. */
  onTurnKey: (next: string) => void;
}

/**
 * Build the "follow the rename" step for one turn.
 *
 * Call the returned function on every event the turn yields, and once more after
 * the stream ends — a turn that yielded nothing still renamed the session.
 * It disarms itself after the first real move, so the extra calls are a map
 * lookup each.
 *
 * @param opts - This turn's identity, seams and chain.
 * @returns The retry step. Never throws on a session that was not renamed.
 */
export function createCanonicalRekey(opts: CanonicalRekeyOpts): () => void {
  const { sessionId, clientId, holder, lockToken, deps, chain } = opts;
  let resolved = false;
  return () => {
    if (resolved) return;
    const canonical = deps.getInternalSessionId(sessionId);
    if (!canonical || canonical === sessionId) return;
    resolved = true;
    deps.rekeyProjector(sessionId, canonical);
    // The projector is not the only thing keyed by session id. The client is
    // about to start using this canonical id (a turn's 202 hands it over, and a
    // run row names it), and anything arriving under it has to meet THIS turn's
    // chain and THIS turn's lock — otherwise a second stream opens into the
    // projector we just re-pointed (DOR-1088 review, G4).
    const current = opts.turnKey();
    if (canonical === current) return;
    chain.link(canonical, current);
    // Move the write-lock rather than holding two: acquire under the new id,
    // then drop the old. A refusal means someone else already holds the
    // canonical id, which this turn cannot resolve — keep the lock we have and
    // let the existing refusal paths answer.
    if (deps.acquireLock(canonical, clientId, holder, lockToken)) {
      deps.releaseLock(current, clientId, lockToken);
      opts.onTurnKey(canonical);
    }
  };
}
