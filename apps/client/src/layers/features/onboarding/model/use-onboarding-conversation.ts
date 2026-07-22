/**
 * The onboarding conversation state machine (ADR 260722-111314).
 *
 * A reducer drives DorkBot's scripted first-run dialogue: which beat is active,
 * which messages have been revealed, whether DorkBot is "typing", and the
 * personality/discovery sub-state. The reducer is pure and synchronous; all
 * mutations (saving traits, completing steps, dissolving into a session) arrive
 * as injected ports so tests can drive the machine without transport or timers.
 *
 * @module features/onboarding/model/use-onboarding-conversation
 */
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import {
  DORKBOT_ONBOARDING_LINES,
  dorkbotDiscoveryFoundLine,
} from '@dorkos/shared/dorkbot-templates';
import type { Traits } from '@dorkos/shared/mesh-schemas';
import type { OnboardingStep } from '@dorkos/shared/config-schema';
import type { ChatMessage, MessageGrouping } from '@/layers/shared/model';
import {
  ONBOARDING_BEATS,
  buildScriptMessage,
  computeGrouping,
  getBeat,
  voiceSampleFor,
  type BeatId,
} from './onboarding-script';

/** Pause before DorkBot starts "typing" the next line (ms). */
const REVEAL_GAP_MS = 420;
/** How long the typing indicator shows before a line lands (ms). */
const REVEAL_TYPING_MS = 680;

/** Where the discovery beat is in its consent → scan → results arc. */
export type DiscoveryPhase = 'unasked' | 'scanning' | 'results';

/** Side effects the conversation needs, injected so tests stay synchronous. */
export interface OnboardingConversationPorts {
  /** Collapse staged reveals to instant when the user prefers reduced motion. */
  reducedMotion: boolean;
  /** Persist DorkBot's chosen traits. Resolves on success, rejects on failure. */
  saveTraits: (traits: Traits) => Promise<void>;
  /** Mark an onboarding step complete. */
  completeStep: (step: OnboardingStep) => void;
  /** Mark an onboarding step skipped. */
  skipStep: (step: OnboardingStep) => void;
  /** Write the authoritative completion timestamp (fired on reaching the handoff beat). */
  completeOnboarding: () => void;
  /** Dissolve the overlay into a real session carrying the user's first message. */
  onDissolve: (text: string) => void;
}

interface ConversationState {
  stage: 'first-light' | 'talking';
  beatIndex: number;
  revealed: ChatMessage[];
  queue: ChatMessage[];
  isTyping: boolean;
  idCounter: number;
  sampleId: string | null;
  saving: boolean;
  saveError: boolean;
  discoveryPhase: DiscoveryPhase;
}

type Action =
  | { type: 'begin' }
  | { type: 'reveal-one' }
  | { type: 'drain' }
  | { type: 'start-typing' }
  | { type: 'set-sample'; text: string }
  | { type: 'saving' }
  | { type: 'save-error' }
  | { type: 'goto-beat'; beatId: BeatId; extraLines: readonly string[] }
  | { type: 'discovery-scanning' }
  | { type: 'discovery-results'; line: string };

const INITIAL_STATE: ConversationState = {
  stage: 'first-light',
  beatIndex: 0,
  revealed: [],
  queue: [],
  isTyping: false,
  idCounter: 0,
  sampleId: null,
  saving: false,
  saveError: false,
  discoveryPhase: 'unasked',
};

/** Queue a run of DorkBot lines, minting stable ids from the running counter. */
function enqueueLines(
  state: ConversationState,
  texts: readonly string[]
): Pick<ConversationState, 'queue' | 'idCounter'> {
  let n = state.idCounter;
  const added = texts.map((t) => buildScriptMessage(`ob-line-${n++}`, 'assistant', t));
  return { queue: [...state.queue, ...added], idCounter: n };
}

/** Index of a beat by id. */
function beatIndexOf(beatId: BeatId): number {
  return ONBOARDING_BEATS.findIndex((b) => b.id === beatId);
}

/** Pure transition function for the conversation. */
export function conversationReducer(state: ConversationState, action: Action): ConversationState {
  switch (action.type) {
    case 'begin': {
      if (state.stage === 'talking') return state;
      return { ...state, stage: 'talking', ...enqueueLines(state, getBeat('arrival').lines) };
    }
    case 'reveal-one': {
      if (state.queue.length === 0) return state;
      const [next, ...rest] = state.queue;
      return { ...state, revealed: [...state.revealed, next], queue: rest, isTyping: false };
    }
    case 'drain': {
      if (state.queue.length === 0) return { ...state, isTyping: false };
      return {
        ...state,
        revealed: [...state.revealed, ...state.queue],
        queue: [],
        isTyping: false,
      };
    }
    case 'start-typing': {
      if (state.queue.length === 0) return state;
      return { ...state, isTyping: true };
    }
    case 'set-sample': {
      if (state.sampleId) {
        return {
          ...state,
          revealed: state.revealed.map((m) =>
            m.id === state.sampleId ? buildScriptMessage(m.id, 'assistant', action.text) : m
          ),
        };
      }
      const id = `ob-sample-${state.idCounter}`;
      return {
        ...state,
        revealed: [...state.revealed, buildScriptMessage(id, 'assistant', action.text)],
        sampleId: id,
        idCounter: state.idCounter + 1,
      };
    }
    case 'saving':
      return { ...state, saving: true, saveError: false };
    case 'save-error':
      return { ...state, saving: false, saveError: true };
    case 'goto-beat': {
      const beat = getBeat(action.beatId);
      return {
        ...state,
        beatIndex: beatIndexOf(action.beatId),
        saving: false,
        discoveryPhase: 'unasked',
        ...enqueueLines(state, [...action.extraLines, ...beat.lines]),
      };
    }
    case 'discovery-scanning':
      return { ...state, discoveryPhase: 'scanning' };
    case 'discovery-results':
      return { ...state, discoveryPhase: 'results', ...enqueueLines(state, [action.line]) };
    default:
      return state;
  }
}

/** What the conversation surface renders and the handlers it drives. */
export interface OnboardingConversation {
  isFirstLight: boolean;
  messages: ChatMessage[];
  grouping: MessageGrouping[];
  isTyping: boolean;
  beatId: BeatId;
  activeWidget: 'personality' | 'discovery' | null;
  composerEnabled: boolean;
  discoveryPhase: DiscoveryPhase;
  saving: boolean;
  saveError: boolean;
  /** Leave the first-light arrival and start the dialogue. */
  beginConversation: () => void;
  /** Reveal every pending line at once (tap-to-skip). */
  fastForward: () => void;
  /** Post a fresh voice sample in the newly chosen personality. */
  selectPersonality: (traits: Traits) => void;
  /** Save the chosen traits and advance; surfaces `saveError` on failure. */
  confirmPersonality: (traits: Traits) => void;
  /** Consent to the discovery scan (the caller starts the actual scan). */
  consentDiscovery: () => void;
  /** Decline the scan and move on. */
  declineDiscovery: () => void;
  /** Report that the scan found candidates. */
  reportDiscoveryResults: (count: number) => void;
  /** Report that the scan found nothing. */
  reportDiscoveryZero: () => void;
  /** Report that the scan exceeded its budget or errored. */
  reportDiscoveryTimeout: () => void;
  /** Finish the discovery beat after the user reviews the found candidates. */
  finishDiscovery: () => void;
  /** Submit the user's first real message and dissolve into a session. */
  submitFirstMessage: (text: string) => void;
}

/**
 * Drive the scripted onboarding conversation.
 *
 * @param ports - Injected side effects (mutations, motion preference, dissolve).
 */
export function useOnboardingConversation(
  ports: OnboardingConversationPorts
): OnboardingConversation {
  const [state, dispatch] = useReducer(conversationReducer, INITIAL_STATE);

  // Latest ports in a ref so handlers/effects stay stable across renders.
  const portsRef = useRef(ports);
  useEffect(() => {
    portsRef.current = ports;
  });

  const beat = ONBOARDING_BEATS[state.beatIndex];
  const drained = state.queue.length === 0 && !state.isTyping;

  // Staged reveal choreography: pause, "type", then land each queued line. A
  // reduced-motion preference collapses the whole queue to instant.
  useEffect(() => {
    if (state.queue.length === 0) return;
    if (portsRef.current.reducedMotion) {
      dispatch({ type: 'drain' });
      return;
    }
    if (state.isTyping) {
      const t = setTimeout(() => dispatch({ type: 'reveal-one' }), REVEAL_TYPING_MS);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => dispatch({ type: 'start-typing' }), REVEAL_GAP_MS);
    return () => clearTimeout(t);
  }, [state.queue.length, state.isTyping]);

  // Arrival has no interaction — once its lines land, roll into the personality beat.
  useEffect(() => {
    if (state.stage === 'talking' && beat.id === 'arrival' && drained) {
      dispatch({ type: 'goto-beat', beatId: 'personality', extraLines: [] });
    }
  }, [state.stage, beat.id, drained]);

  // Reaching the handoff beat is the authoritative "onboarding done" signal.
  const completedRef = useRef(false);
  useEffect(() => {
    if (beat.id === 'handoff' && !completedRef.current) {
      completedRef.current = true;
      portsRef.current.completeOnboarding();
    }
  }, [beat.id]);

  const beginConversation = useCallback(() => dispatch({ type: 'begin' }), []);
  const fastForward = useCallback(() => dispatch({ type: 'drain' }), []);

  const selectPersonality = useCallback((traits: Traits) => {
    dispatch({ type: 'set-sample', text: voiceSampleFor(traits) });
  }, []);

  const confirmPersonality = useCallback((traits: Traits) => {
    dispatch({ type: 'saving' });
    portsRef.current
      .saveTraits(traits)
      .then(() => {
        portsRef.current.completeStep('meet-dorkbot');
        dispatch({ type: 'goto-beat', beatId: 'discovery', extraLines: [] });
      })
      .catch(() => dispatch({ type: 'save-error' }));
  }, []);

  const consentDiscovery = useCallback(() => dispatch({ type: 'discovery-scanning' }), []);

  const declineDiscovery = useCallback(() => {
    portsRef.current.skipStep('discovery');
    dispatch({
      type: 'goto-beat',
      beatId: 'handoff',
      extraLines: [DORKBOT_ONBOARDING_LINES.discoveryDecline],
    });
  }, []);

  const reportDiscoveryResults = useCallback((count: number) => {
    dispatch({ type: 'discovery-results', line: dorkbotDiscoveryFoundLine(count) });
  }, []);

  const reportDiscoveryZero = useCallback(() => {
    portsRef.current.completeStep('discovery');
    dispatch({
      type: 'goto-beat',
      beatId: 'handoff',
      extraLines: [DORKBOT_ONBOARDING_LINES.discoveryZero],
    });
  }, []);

  const reportDiscoveryTimeout = useCallback(() => {
    portsRef.current.skipStep('discovery');
    dispatch({
      type: 'goto-beat',
      beatId: 'handoff',
      extraLines: [DORKBOT_ONBOARDING_LINES.discoveryTimeout],
    });
  }, []);

  const finishDiscovery = useCallback(() => {
    portsRef.current.completeStep('discovery');
    dispatch({ type: 'goto-beat', beatId: 'handoff', extraLines: [] });
  }, []);

  const submitFirstMessage = useCallback((text: string) => {
    portsRef.current.onDissolve(text);
  }, []);

  const grouping = useMemo(() => computeGrouping(state.revealed), [state.revealed]);
  const activeWidget = state.stage === 'talking' && drained && beat.widget ? beat.widget : null;
  const composerEnabled = state.stage === 'talking' && beat.composerEnabled && drained;

  return {
    isFirstLight: state.stage === 'first-light',
    messages: state.revealed,
    grouping,
    isTyping: state.isTyping,
    beatId: beat.id,
    activeWidget,
    composerEnabled,
    discoveryPhase: state.discoveryPhase,
    saving: state.saving,
    saveError: state.saveError,
    beginConversation,
    fastForward,
    selectPersonality,
    confirmPersonality,
    consentDiscovery,
    declineDiscovery,
    reportDiscoveryResults,
    reportDiscoveryZero,
    reportDiscoveryTimeout,
    finishDiscovery,
    submitFirstMessage,
  };
}
