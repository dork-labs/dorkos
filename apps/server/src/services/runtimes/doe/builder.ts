/** Builder assembly delegates coding and process lifecycle to the standalone engine. */
import {
  createBuilderTool,
  type ExecutionPolicy,
  type PathPolicy,
  type Resources,
  type ToolDescriptor,
  type ContextScope,
  type ModelRunResult,
} from '@dorkos/doe';
/** Parent correlation for the engine-owned child scope; IDs are actual model tool call IDs. */
export interface DoeBuilderLifecycle {
  /** Announce the child before its first engine event. */
  onChildStart?: (scope: ContextScope, parentCallId: string) => void;
  /** Complete the correlated child with its actual execution result or failure. */
  onChildEnd?: (
    scope: ContextScope,
    outcome: { kind: 'result'; result: ModelRunResult } | { kind: 'error'; error: unknown }
  ) => void;
}
/** Create the separate coding child with only caller-supplied execution authority. */
export function doeBuilderTool(
  options: {
    cwd: string;
    resources: Resources;
    pathPolicy: PathPolicy;
    executionPolicy?: ExecutionPolicy;
  } & DoeBuilderLifecycle
): ToolDescriptor {
  const tool = createBuilderTool({
    workingDirectory: options.cwd,
    resources: options.resources,
    pathPolicy: options.pathPolicy,
    executionPolicy: options.executionPolicy,
    maxResultCharacters: 16000,
    maxDurationMs: 120000,
    maxOutputBytes: 1048576,
    guidance:
      'Implement business tools and skill scripts. Respect the approved paths and host permissions.',
  });
  return {
    ...tool,
    execute: (args, context) =>
      tool.execute(args, {
        ...context,
        ...(context.execute
          ? {
              execute: async (child) => {
                const correlated =
                  child.purpose === 'builder' &&
                  child.scope.startsWith('child:') &&
                  !!context.callId;
                if (correlated) options.onChildStart?.(child.scope, context.callId!);
                const signal = child.signal ?? context.signal;
                let abort: () => void = () => {};
                const cancelled = new Promise<never>((_, reject) => {
                  abort = () => reject(signal.reason ?? new Error('Builder child aborted'));
                  signal.addEventListener('abort', abort, { once: true });
                });
                let result: ModelRunResult;
                try {
                  signal.throwIfAborted();
                  result = await Promise.race([context.execute!(child), cancelled]);
                } catch (error) {
                  if (correlated) options.onChildEnd?.(child.scope, { kind: 'error', error });
                  throw error;
                } finally {
                  signal.removeEventListener('abort', abort);
                }
                if (correlated) options.onChildEnd?.(child.scope, { kind: 'result', result });
                return result;
              },
            }
          : {}),
      }),
  };
}
