import type {
  ApprovalCallback,
  ContextScope,
  DoeEvent,
  ModelDescriptor,
  ModelMessage,
  ModelUsage,
  QueueDisposition,
  ToolContext,
  ToolDescriptor,
} from './contracts.js';
/** Complete model request. Pi types never cross this internal boundary. */
export interface EngineRequest {
  prompt: string;
  model: ModelDescriptor;
  messages: readonly ModelMessage[];
  tools: readonly ToolDescriptor[];
  context: ToolContext;
  approve?: ApprovalCallback;
  signal: AbortSignal;
  onEvent: (event: DoeEvent) => void;
  onMessage: (message: ModelMessage) => Promise<void>;
  purpose?: ModelUsage['purpose'];
  retry?: import('./contracts.js').RetryPolicy;
  onUsage: (usage: ModelUsage) => Promise<void>;
  prepareRequest?: (
    messages: readonly ModelMessage[],
    signal: AbortSignal
  ) => Promise<{
    prompt?: string;
    messages?: readonly ModelMessage[];
    tools?: readonly ToolDescriptor[];
  }>;
  finishTurn?: (
    messages: readonly ModelMessage[],
    signal: AbortSignal
  ) => Promise<'continue' | 'end'>;
}
/** Terminal engine outcome distinguishes failed and length-stopped summaries. */
export interface EngineResult {
  /** A host approval was denied or malformed; a later normal stop does not erase that fact. */
  approvalDenied?: boolean;
  messages: readonly ModelMessage[];
  stopReason: 'stop' | 'length' | 'error' | 'aborted';
  scope: ContextScope;
}
/** Single Pi implementation owns loop, queues, provider calls and event translation. */
export interface Engine {
  run(request: EngineRequest): Promise<EngineResult>;
  steer(message: ModelMessage): QueueDisposition;
  followUp(message: ModelMessage): QueueDisposition;
  abort(): void;
}
/** Factory enables offline scripted engines without exposing Pi types. */
export type EngineFactory = () => Engine;
