/**
 * Shared setup for the sdk-event-mapper tests, split from one file by subject.
 */
import { mapSdkMessage } from '../../sdk/sdk-event-mapper.js';
import type { AgentSession, ToolState } from '../../agent-types.js';
import type { StreamEvent } from '@dorkos/shared/types';

/** Collect all events yielded by the mapper for a single message. */
export async function collectEvents(
  ...args: Parameters<typeof mapSdkMessage>
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of mapSdkMessage(...args)) {
    events.push(event);
  }
  return events;
}

/** Shared helper for the sdk-event-mapper tests: `makeSession`. */
export function makeSession(): AgentSession {
  return {
    sdkSessionId: null,
    hasStarted: false,
  } as unknown as AgentSession;
}

/** Shared helper for the sdk-event-mapper tests: `makeToolState`. */
export function makeToolState(): ToolState {
  return {
    inTool: false,
    currentToolName: '',
    currentToolId: '',
    taskToolInput: '',
    toolNameById: new Map(),
    setToolState(inTool: boolean, name: string, id: string) {
      this.inTool = inTool;
      this.currentToolName = name;
      this.currentToolId = id;
    },
    resetTaskInput() {
      this.taskToolInput = '';
    },
    appendTaskInput(chunk: string) {
      this.taskToolInput += chunk;
    },
  } as ToolState;
}

// --- Hook lifecycle SDK message factories ---

export type SDKMessage = Parameters<typeof mapSdkMessage>[0];

/** Shared helper for the sdk-event-mapper tests: `sdkHookStarted`. */
export function sdkHookStarted(hookId: string, hookName: string, hookEvent: string): SDKMessage {
  return {
    type: 'system',
    subtype: 'hook_started',
    hook_id: hookId,
    hook_name: hookName,
    hook_event: hookEvent,
    uuid: `uuid-${hookId}`,
    session_id: 'test-session',
  } as unknown as SDKMessage;
}

/** Shared helper for the sdk-event-mapper tests: `sdkHookProgress`. */
export function sdkHookProgress(
  hookId: string,
  hookName: string,
  hookEvent: string,
  stdout: string,
  stderr: string
): SDKMessage {
  return {
    type: 'system',
    subtype: 'hook_progress',
    hook_id: hookId,
    hook_name: hookName,
    hook_event: hookEvent,
    stdout,
    stderr,
    output: stdout + stderr,
    uuid: `uuid-${hookId}-progress`,
    session_id: 'test-session',
  } as unknown as SDKMessage;
}

/** Shared helper for the sdk-event-mapper tests: `sdkHookResponse`. */
export function sdkHookResponse(
  hookId: string,
  hookName: string,
  hookEvent: string,
  outcome: string,
  exitCode?: number,
  stdout = '',
  stderr = ''
): SDKMessage {
  return {
    type: 'system',
    subtype: 'hook_response',
    hook_id: hookId,
    hook_name: hookName,
    hook_event: hookEvent,
    output: stdout + stderr,
    stdout,
    stderr,
    exit_code: exitCode,
    outcome,
    uuid: `uuid-${hookId}-response`,
    session_id: 'test-session',
  } as unknown as SDKMessage;
}
