import type { ChatMessage, ChatStatus, ToolCallState } from '@/layers/features/chat/model/chat-types';
import type { MessagePart } from '@dorkos/shared/types';

/** Base fields shared by all simulation steps. */
interface SimStepBase {
  /** Delay in ms before executing this step (affected by speed multiplier). */
  delayMs?: number;
}

/** A single atomic action in a simulation scenario. */
export type SimStep =
  | ({ type: 'append_message'; message: ChatMessage } & SimStepBase)
  | ({ type: 'update_message'; messageId: string; patch: Partial<ChatMessage> } & SimStepBase)
  | ({ type: 'stream_text_chunk'; messageId: string; text: string } & SimStepBase)
  | ({ type: 'append_tool_call'; messageId: string; toolCall: ToolCallState } & SimStepBase)
  | ({ type: 'update_tool_call'; messageId: string; toolCallId: string; patch: Partial<ToolCallState> } & SimStepBase)
  | ({ type: 'append_part'; messageId: string; part: MessagePart } & SimStepBase)
  | ({ type: 'set_status'; status: ChatStatus } & SimStepBase)
  | ({ type: 'set_streaming'; isTextStreaming: boolean } & SimStepBase)
  | ({ type: 'set_waiting'; isWaiting: boolean; waitingType?: 'approval' | 'question' } & SimStepBase);

/** A named sequence of simulation steps with metadata. */
export interface SimScenario {
  /** Unique ID used as scenario selector key. */
  id: string;
  /** Display name in the scenario picker. */
  title: string;
  /** Short description shown below the label. */
  description: string;
  /** The ordered sequence of simulation steps. */
  steps: SimStep[];
}
