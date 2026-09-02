/**
 * A pick of a target agent that cannot be priced yet, and what the form does
 * about it.
 *
 * **The policy is to WAIT, not to guess.** Choosing an agent moves the runtime a
 * task inherits, and a mode id means whatever the runtime running it says it
 * means — so a pick has to be priced against the candidate's own runtime before
 * it commits, or a scheduled run can end up never asking with nobody having
 * agreed to it (DOR-1637).
 *
 * That price is not always available at the moment of the click. The manifests
 * that name each agent's runtime are read in a request that is strictly
 * downstream of the agent LIST, and the picker is clickable as soon as the list
 * lands — so there is a guaranteed window, not a theoretical one, in which every
 * candidate's runtime reads as unknown. Taking unknown for "names no runtime"
 * resolves it to the server default, which is the runtime the task is already
 * on: nothing looks widened, the pick applies, and no door ever opens. That is
 * the defect, and the reason this module exists rather than a bare call.
 *
 * So a pick made in that window is HELD — not dropped, and not applied — until
 * the manifests answer, and then priced and either made or asked about. If they
 * cannot be read at all, it stays held and the caller says so: the agent is
 * unchanged either way, and the difference is only whether waiting will fix it.
 *
 * @module features/tasks/ui/use-agent-pick
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AgentRuntimeLookup } from './use-task-execution';

/** What {@link useAgentPick} is wired to. */
export interface AgentPickInput {
  /** What is known about the picker agents' runtimes. */
  runtimes: AgentRuntimeLookup;
  /**
   * Make the pick, now that what it costs is known.
   *
   * The caller prices and applies it — this module decides only WHEN that may
   * happen, never what the answer is.
   *
   * @param agentId - The agent being chosen, or `''` for none.
   * @param candidateRuntime - That agent's own manifest runtime, or `null` when
   *   it names none. Never "not answered yet": this is only called once it is.
   */
  onResolved: (agentId: string, candidateRuntime: string | null) => void;
}

/** A target-agent picker that will not commit a change it cannot price. */
export interface AgentPick {
  /**
   * Choose `agentId` — now if its runtime is known, otherwise as soon as it is.
   *
   * @param agentId - The agent being chosen, or `''` for none.
   */
  pick: (agentId: string) => void;
  /** Whether a pick is waiting on an answer that has not arrived. */
  isWaiting: boolean;
  /** Whether that answer failed rather than merely being slow. */
  unreadable: boolean;
}

/**
 * Hold a target-agent pick until it can be priced, then hand it back.
 *
 * @param input - The runtime lookup and what to do once a pick can be priced;
 *   see {@link AgentPickInput}.
 */
export function useAgentPick(input: AgentPickInput): AgentPick {
  const { runtimes, onResolved } = input;
  const [held, setHeld] = useState<string | null>(null);

  // Latest-value ref, kept fresh in an effect rather than during render (a
  // render-time ref write is impure). It exists so the effect below depends on
  // the two things that decide WHEN a held pick is spent, and not on every
  // value that decides what spending it does.
  const onResolvedRef = useRef(onResolved);
  useLayoutEffect(() => {
    onResolvedRef.current = onResolved;
  });

  // The held id is deliberately NOT cleared once spent. Leaving it makes this
  // dependency list change exactly when there is something new to do, so a pick
  // is handed back once and never re-applied on a later render.
  useEffect(() => {
    if (held === null || !runtimes.known) return;
    onResolvedRef.current(held, runtimes.runtimeFor(held));
    // `runtimeFor` is rebuilt every render and reads the same resolved data as
    // `known`, which is what actually moves; depending on it as well would spend
    // the pick again on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [held, runtimes.known]);

  return {
    pick: (agentId) => {
      if (!runtimes.known) {
        setHeld(agentId);
        return;
      }
      onResolved(agentId, runtimes.runtimeFor(agentId));
    },
    isWaiting: held !== null && !runtimes.known,
    unreadable: runtimes.unreadable,
  };
}
