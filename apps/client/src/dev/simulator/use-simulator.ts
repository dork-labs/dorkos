import { useReducer, useEffect, useRef, useCallback, useState } from 'react';
import type {
  ChatMessage,
  ChatStatus,
  ToolCallState,
} from '@/layers/features/chat/model/chat-types';
import type { MessagePart } from '@dorkos/shared/types';
import type { SimScenario, SimStep } from './sim-types';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type Phase = 'idle' | 'playing' | 'paused' | 'done';

interface SimulatorState {
  messages: ChatMessage[];
  status: ChatStatus;
  isTextStreaming: boolean;
  isWaitingForUser: boolean;
  waitingType: 'approval' | 'question' | undefined;
}

type Action =
  | { type: 'reset' }
  | { type: 'append_message'; message: ChatMessage }
  | { type: 'update_message'; messageId: string; patch: Partial<ChatMessage> }
  | { type: 'stream_text_chunk'; messageId: string; text: string }
  | { type: 'set_streaming'; isTextStreaming: boolean }
  | { type: 'append_tool_call'; messageId: string; toolCall: ToolCallState }
  | {
      type: 'update_tool_call';
      messageId: string;
      toolCallId: string;
      patch: Partial<ToolCallState>;
    }
  | { type: 'append_part'; messageId: string; part: MessagePart }
  | { type: 'set_status'; status: ChatStatus }
  | { type: 'set_waiting'; isWaiting: boolean; waitingType?: 'approval' | 'question' };

const INITIAL_STATE: SimulatorState = {
  messages: [],
  status: 'idle',
  isTextStreaming: false,
  isWaitingForUser: false,
  waitingType: undefined,
};

function updateMessage(
  messages: ChatMessage[],
  messageId: string,
  updater: (msg: ChatMessage) => ChatMessage
): ChatMessage[] {
  return messages.map((m) => (m.id === messageId ? updater(m) : m));
}

function reducer(state: SimulatorState, action: Action): SimulatorState {
  switch (action.type) {
    case 'reset':
      return INITIAL_STATE;

    case 'append_message':
      return { ...state, messages: [...state.messages, action.message] };

    case 'update_message':
      return {
        ...state,
        messages: updateMessage(state.messages, action.messageId, (msg) => ({
          ...msg,
          ...action.patch,
        })),
      };

    case 'stream_text_chunk': {
      return {
        ...state,
        messages: updateMessage(state.messages, action.messageId, (msg) => {
          const newContent = msg.content + action.text;
          const parts = [...msg.parts];
          const lastPart = parts[parts.length - 1];
          if (lastPart && lastPart.type === 'text') {
            parts[parts.length - 1] = {
              ...lastPart,
              text: (lastPart as { text: string }).text + action.text,
            };
          } else {
            parts.push({ type: 'text', text: action.text } as MessagePart);
          }
          return { ...msg, content: newContent, parts };
        }),
      };
    }

    case 'set_streaming':
      return { ...state, isTextStreaming: action.isTextStreaming };

    case 'append_tool_call': {
      return {
        ...state,
        messages: updateMessage(state.messages, action.messageId, (msg) => {
          const toolCalls = [...(msg.toolCalls ?? []), action.toolCall];
          const parts: MessagePart[] = [
            ...msg.parts,
            {
              type: 'tool_call',
              toolCallId: action.toolCall.toolCallId,
              toolName: action.toolCall.toolName,
              input: action.toolCall.input,
              status: action.toolCall.status,
              result: action.toolCall.result,
              interactiveType: action.toolCall.interactiveType,
              questions: action.toolCall.questions,
            } as MessagePart,
          ];
          return { ...msg, toolCalls, parts };
        }),
      };
    }

    case 'update_tool_call': {
      return {
        ...state,
        messages: updateMessage(state.messages, action.messageId, (msg) => {
          const toolCalls = msg.toolCalls?.map((tc) =>
            tc.toolCallId === action.toolCallId ? { ...tc, ...action.patch } : tc
          );
          const parts = msg.parts.map((p) => {
            if (p.type === 'tool_call' && 'toolCallId' in p && p.toolCallId === action.toolCallId) {
              return { ...p, ...action.patch };
            }
            return p;
          });
          return { ...msg, toolCalls, parts };
        }),
      };
    }

    case 'append_part': {
      return {
        ...state,
        messages: updateMessage(state.messages, action.messageId, (msg) => ({
          ...msg,
          parts: [...msg.parts, action.part],
        })),
      };
    }

    case 'set_status':
      return { ...state, status: action.status };

    case 'set_waiting':
      return {
        ...state,
        isWaitingForUser: action.isWaiting,
        waitingType: action.waitingType,
      };
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/** Speed presets available in the UI. */
export const SPEED_PRESETS = [0.25, 0.5, 1, 2, 4] as const;

export interface SimulatorResult {
  messages: ChatMessage[];
  status: ChatStatus;
  isTextStreaming: boolean;
  isWaitingForUser: boolean;
  waitingType: 'approval' | 'question' | undefined;
  phase: Phase;
  stepIndex: number;
  totalSteps: number;
  play: () => void;
  pause: () => void;
  step: () => void;
  reset: () => void;
  seekTo: (targetIndex: number) => void;
  speed: number;
  setSpeed: (s: number) => void;
}

/** Process a single SimStep by dispatching the corresponding reducer action. */
function dispatchStep(step: SimStep, dispatch: React.Dispatch<Action>): void {
  switch (step.type) {
    case 'append_message':
      dispatch({ type: 'append_message', message: step.message });
      break;
    case 'update_message':
      dispatch({ type: 'update_message', messageId: step.messageId, patch: step.patch });
      break;
    case 'stream_text_chunk':
      dispatch({ type: 'stream_text_chunk', messageId: step.messageId, text: step.text });
      break;
    case 'set_streaming':
      dispatch({ type: 'set_streaming', isTextStreaming: step.isTextStreaming });
      break;
    case 'append_tool_call':
      dispatch({ type: 'append_tool_call', messageId: step.messageId, toolCall: step.toolCall });
      break;
    case 'update_tool_call':
      dispatch({
        type: 'update_tool_call',
        messageId: step.messageId,
        toolCallId: step.toolCallId,
        patch: step.patch,
      });
      break;
    case 'append_part':
      dispatch({ type: 'append_part', messageId: step.messageId, part: step.part });
      break;
    case 'set_status':
      dispatch({ type: 'set_status', status: step.status });
      break;
    case 'set_waiting':
      dispatch({ type: 'set_waiting', isWaiting: step.isWaiting, waitingType: step.waitingType });
      break;
  }
}

/** Drives a SimScenario through a useReducer state machine with setTimeout ticks. */
export function useSimulator(scenario: SimScenario | null): SimulatorResult {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const [phase, setPhase] = useState<Phase>('idle');
  const [stepIndex, setStepIndex] = useState(0);
  const [speed, setSpeed] = useState(1);

  const phaseRef = useRef(phase);
  const stepIndexRef = useRef(stepIndex);
  const speedRef = useRef(speed);
  const steps = scenario?.steps ?? [];
  const stepsRef = useRef(steps);

  // Sync refs in an effect to satisfy react-hooks/refs lint rule
  useEffect(() => {
    phaseRef.current = phase;
    stepIndexRef.current = stepIndex;
    speedRef.current = speed;
    stepsRef.current = steps;
  });

  /** Advance one step. Returns the delay (ms) before the next step should fire. */
  const advanceOne = useCallback(() => {
    const idx = stepIndexRef.current;
    const allSteps = stepsRef.current;
    if (idx >= allSteps.length) {
      setPhase('done');
      return 0;
    }

    const s = allSteps[idx];
    dispatchStep(s, dispatch);

    const nextIdx = idx + 1;
    setStepIndex(nextIdx);

    if (nextIdx >= allSteps.length) {
      setPhase('done');
      return 0;
    }

    return s.delayMs ?? 0;
  }, []);

  // Tick engine: auto-advance when playing
  useEffect(() => {
    if (phase !== 'playing') return;

    let timeoutId: ReturnType<typeof setTimeout>;

    const tick = () => {
      if (phaseRef.current !== 'playing') return;

      const delayMs = advanceOne();
      if (phaseRef.current === 'playing') {
        const effectiveDelay = delayMs > 0 ? delayMs / speedRef.current : 0;
        timeoutId = setTimeout(tick, effectiveDelay);
      }
    };

    timeoutId = setTimeout(tick, 0);
    return () => clearTimeout(timeoutId);
  }, [phase, advanceOne]);

  const play = useCallback(() => {
    if (stepIndexRef.current >= stepsRef.current.length) return;
    setPhase('playing');
  }, []);

  const pause = useCallback(() => {
    setPhase('paused');
  }, []);

  const manualStep = useCallback(() => {
    if (stepIndexRef.current >= stepsRef.current.length) return;
    if (phaseRef.current === 'idle' || phaseRef.current === 'paused') {
      setPhase('paused');
    }
    advanceOne();
  }, [advanceOne]);

  const reset = useCallback(() => {
    setPhase('idle');
    setStepIndex(0);
    dispatch({ type: 'reset' });
  }, []);

  /** Replay all steps from 0 to targetIndex synchronously (for timeline scrubbing). */
  const seekTo = useCallback((targetIndex: number) => {
    dispatch({ type: 'reset' });
    const allSteps = stepsRef.current;
    const clamped = Math.min(targetIndex, allSteps.length);
    for (let i = 0; i < clamped; i++) {
      dispatchStep(allSteps[i], dispatch);
    }
    setStepIndex(clamped);
    setPhase(clamped >= allSteps.length ? 'done' : 'paused');
  }, []);

  // Reset when scenario changes
  useEffect(() => {
    reset();
  }, [scenario?.id, reset]);

  return {
    messages: state.messages,
    status: state.status,
    isTextStreaming: state.isTextStreaming,
    isWaitingForUser: state.isWaitingForUser,
    waitingType: state.waitingType,
    phase,
    stepIndex,
    totalSteps: steps.length,
    play,
    pause,
    step: manualStep,
    reset,
    seekTo,
    speed,
    setSpeed,
  };
}
