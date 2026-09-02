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
 * the manifests answer, and then priced and either made or asked about. It is
 * spent EXACTLY ONCE, which is a rule with teeth: "the manifests are known" is
 * not a one-way door. The resolve query re-mints its key whenever the agent
 * roster changes and holds no placeholder data, and it refetches on window
 * focus, so `known` goes false→true again and again over a form's life. A pick
 * left latched fires on every one of those edges — clobbering a later pick the
 * person actually made, or re-applying one they had already turned down at the
 * consent door.
 *
 * A pick that can never be priced is DROPPED and said so, rather than held
 * against a resolve that may succeed much later and apply a choice from another
 * minute of somebody's attention.
 *
 * @module features/tasks/ui/use-agent-pick
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { AgentRuntimeLookup } from './use-task-execution';

/**
 * A pick that could not be priced when it was made.
 *
 * `held` carries the agent it is about; `dropped` carries none, because the
 * choice is gone and only the fact that it was is worth telling somebody.
 */
type PickState = { status: 'idle' } | { status: 'held'; agentId: string } | { status: 'dropped' };

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
  /** Whether the last pick was let go because that answer never came. */
  wasDropped: boolean;
}

/**
 * Hold a target-agent pick until it can be priced, then hand it back once.
 *
 * @param input - The runtime lookup and what to do once a pick can be priced;
 *   see {@link AgentPickInput}.
 */
export function useAgentPick(input: AgentPickInput): AgentPick {
  const { runtimes, onResolved } = input;
  const [state, setState] = useState<PickState>({ status: 'idle' });

  // Latest-value ref, kept fresh in an effect rather than during render (a
  // render-time ref write is impure). It exists so the effect below depends on
  // the things that decide WHEN a held pick is spent, and not on every value
  // that decides what spending it does.
  const onResolvedRef = useRef(onResolved);
  useLayoutEffect(() => {
    onResolvedRef.current = onResolved;
  });

  // Retiring a held pick IS state this component owns, and the thing that
  // retires it is an answer arriving from outside — so `set-state-in-effect` is
  // disabled here deliberately rather than worked around. The cascade the rule
  // warns about is bounded and the point: each `setState` moves the state
  // machine off `held`, so the re-run it provokes hits the first line and stops.
  // The alternative shapes are worse — a ref-guard would leave the "checking…"
  // note on screen with no render to clear it, and not clearing at all is the
  // latch this whole comment block exists because of.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (state.status !== 'held') return;
    // Cleared BEFORE it is spent, so this effect's next run finds nothing held.
    // Clearing after, or not at all, leaves the pick latched for every later
    // false→true edge of `known`, and there are many.
    if (runtimes.known) {
      setState({ status: 'idle' });
      onResolvedRef.current(state.agentId, runtimes.runtimeFor(state.agentId));
      return;
    }
    // Not slow, but unanswerable. Letting it go beats keeping it: a read that
    // recovers minutes later would otherwise apply a choice the person has long
    // since moved on from.
    if (runtimes.unreadable) setState({ status: 'dropped' });
    // `runtimeFor` is rebuilt on every render and reads exactly the data
    // `known` reports on, so depending on it too would only add renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, runtimes.known, runtimes.unreadable]);
  /* eslint-enable react-hooks/set-state-in-effect */

  return {
    pick: (agentId) => {
      if (!runtimes.known) {
        setState({ status: 'held', agentId });
        return;
      }
      // Idle even on the straight-through path: a pick made while the answer is
      // in hand also retires whatever an earlier one left outstanding, so the
      // stale note goes with it.
      setState({ status: 'idle' });
      onResolved(agentId, runtimes.runtimeFor(agentId));
    },
    isWaiting: state.status === 'held',
    wasDropped: state.status === 'dropped',
  };
}
