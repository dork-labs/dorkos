import type {
  DoeEvent,
  ModelDescriptor,
  ModelUsage,
  ContextScope,
  ModelRunResult,
} from '@dorkos/doe';
import type { StreamEvent } from '@dorkos/shared/types';
import { describeRuntimeError } from '@dorkos/shared/runtime-error-classification';

/** Accumulate real provider readings without inventing missing cost or token counts. */
export class DoeTurnEvents {
  private readonly usages: ModelUsage[] = [];
  private compactionStarted?: number;
  private readonly children = new Map<
    string,
    { parentCallId: string; started: number; toolUses: number }
  >();

  /** Translate engine events; only parent text becomes the person's assistant reply. */
  constructor(
    private readonly sessionId: string,
    private readonly model: ModelDescriptor,
    private readonly emit: (event: StreamEvent) => void,
    private readonly compactionTrigger: 'manual' | 'auto' = 'auto',
    private readonly cumulativeCost?: () => number | undefined
  ) {}

  /** Correlate the real child scope before any child callback reaches the display stream. */
  childStarted = (scope: ContextScope, parentCallId: string): void => {
    if (this.children.has(scope)) return;
    const started = Date.now();
    this.children.set(scope, { parentCallId, started, toolUses: 0 });
    this.emit({
      type: 'background_task_started',
      data: {
        taskId: scope,
        taskType: 'agent',
        toolUseId: parentCallId,
        startedAt: started,
        description: 'DorkOS builder',
      },
    });
  };
  /** Finish the correlated child exactly once after its execution reports an outcome. */
  childEnded = (
    scope: ContextScope,
    outcome: { kind: 'result'; result: ModelRunResult } | { kind: 'error'; error: unknown }
  ): void => {
    const child = this.children.get(scope);
    if (!child) return;
    this.children.delete(scope);
    const status =
      outcome.kind === 'error'
        ? 'failed'
        : outcome.result.stopReason === 'stop'
          ? 'completed'
          : outcome.result.stopReason === 'aborted'
            ? 'stopped'
            : 'failed';
    this.emit({
      type: 'background_task_done',
      data: {
        taskId: scope,
        status,
        toolUses: child.toolUses,
        durationMs: Date.now() - child.started,
      },
    });
  };

  /** Receive model, tool and progress callbacks from the engine and its children. */
  receive = (event: DoeEvent): void => {
    const parent = event.scope === 'main';
    if (event.scope.startsWith('child:') && event.type !== 'usage') {
      const child = this.children.get(event.scope);
      if (!child) return;
      if (event.type === 'text')
        this.emit({
          type: 'subagent_text_delta',
          data: {
            parentToolUseId: child.parentCallId,
            text: event.delta,
          },
        });
      else if (['tool-start', 'tool-progress', 'tool-end'].includes(event.type)) {
        if (event.type === 'tool-start') child.toolUses++;
        this.emit({
          type: 'background_task_progress',
          data: {
            taskId: event.scope,
            toolUses: child.toolUses,
            durationMs: Date.now() - child.started,
            ...('name' in event ? { lastToolName: event.name } : {}),
          },
        });
      }
      return;
    }
    switch (event.type) {
      case 'text':
        if (parent) this.emit({ type: 'text_delta', data: { text: event.delta } });

        break;
      case 'thinking':
        if (parent) this.emit({ type: 'thinking_delta', data: { text: event.delta } });
        break;
      case 'tool-start':
        this.emit({
          type: 'tool_call_start',
          data: { toolCallId: event.callId, toolName: event.name, status: 'running' },
        });
        break;
      case 'tool-progress':
        this.emit({
          type: 'tool_progress',
          data: { toolCallId: event.callId, content: event.progress ?? '' },
        });
        break;
      case 'tool-end':
        this.emit({
          type: 'tool_result',
          data: {
            toolCallId: event.callId,
            toolName: event.name,
            status: event.result?.isError ? 'error' : 'complete',
            result: JSON.stringify(event.result ?? {}),
          },
        });
        break;
      case 'usage':
        this.usages.push(event.usage);
        // A child/summary's input size is not the main conversation's window reading.
        if (parent)
          this.emit({
            type: 'session_status',
            data: {
              sessionId: this.sessionId,
              model: event.usage.modelId ?? this.model.id,
              ...(event.usage.inputTokens !== undefined
                ? { contextTokens: event.usage.inputTokens }
                : {}),
              contextMaxTokens: this.model.contextWindow,
              ...(event.usage.outputTokens !== undefined
                ? { outputTokens: event.usage.outputTokens }
                : {}),
            },
          });
        break;
      case 'compaction-start':
        if (parent) {
          this.compactionStarted = Date.now();
          this.emit({
            type: 'operation_progress',
            data: {
              operation: 'compaction',
              state: 'started',
              determinate: false,
            },
          });
        }
        break;
      case 'compaction-end':
        if (!parent) break;
        if (event.outcome === 'completed') {
          this.emit({
            type: 'compact_boundary',
            data: {
              trigger: this.compactionTrigger,
              preTokens: event.before.tokens,
              postTokens: event.after.tokens,
              durationMs: Date.now() - (this.compactionStarted ?? Date.now()),
            },
          });
          this.emit({
            type: 'session_status',
            data: {
              sessionId: this.sessionId,
              contextTokens: event.after.tokens,
              contextMaxTokens: this.model.contextWindow,
            },
          });
        }
        this.emit({
          type: 'operation_progress',
          data: {
            operation: 'compaction',
            state: event.outcome === 'completed' ? 'done' : 'failed',
            determinate: false,
            ...(event.outcome !== 'completed' ? { error: event.error } : {}),
          },
        });
        break;
      // The adapter emits its single terminal only after all engine and host ownership drains.
      case 'complete':
      case 'aborted':
      case 'error':
      case 'retry':
      case 'substitution':
        break;
    }
  };

  /** Sum only known values, preserving unknown totals rather than reporting guessed zeros. */
  private total(field: 'inputTokens' | 'outputTokens' | 'costUsd'): number | undefined {
    if (!this.usages.length || this.usages.some((usage) => usage[field] === undefined))
      return undefined;
    return this.usages.reduce((sum, usage) => sum + (usage[field] ?? 0), 0);
  }

  /** Emit terminal usage separately from context-window readings. */
  finish(reason: string, stopWasRequested: boolean): void {
    const cost = this.total('costUsd');
    let cumulative: number | undefined = cost;
    if (this.cumulativeCost) {
      try {
        cumulative = this.cumulativeCost();
      } catch {
        // A failed ledger read means the total is unknown, never this turn's cost.
        cumulative = undefined;
      }
    }
    const input = this.total('inputTokens');
    const output = this.total('outputTokens');
    this.emit({
      type: 'session_status',
      data: {
        sessionId: this.sessionId,
        model: this.model.id,
        terminalReason: reason,
        ...(reason === 'interrupted' ? { stopWasRequested } : {}),
        ...(input !== undefined ? { turnInputTokens: input } : {}),
        ...(output !== undefined ? { turnOutputTokens: output } : {}),
        ...(cost !== undefined ? { turnCostUsd: cost } : {}),
        ...(cumulative !== undefined
          ? { costUsd: cumulative, usage: { kind: 'pay-as-you-go', costUsd: cumulative } }
          : {}),
      },
    });
  }
}

/** Shared auth/model wording with raw backend details retained behind the disclosure. */
export function doeErrorEvent(error: unknown): StreamEvent {
  const message = error instanceof Error ? error.message : String(error);
  return { type: 'error', data: describeRuntimeError({ runtimeType: 'doe', message }) };
}
