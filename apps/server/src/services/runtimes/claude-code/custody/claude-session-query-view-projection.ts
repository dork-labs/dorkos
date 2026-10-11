import type { SessionOpts } from '@dorkos/shared/agent-runtime';
import type { OriginalClaudeSessionQueries } from './claude-session-query-custody.js';
import type { ClaudeCodeRuntime } from '../claude-code-runtime.js';

const originalClaudeSessionQueryFreeze = Object.freeze;
const originalClaudeSessionQueryApply = Reflect.apply;

/** Caller-owned fixed readers only; no key, map, registrar or operational admission is created. */
export interface OriginalClaudeSessionQueryProjectionSources {
  readonly owner: ClaudeCodeRuntime;
  readonly transcriptReader: () => OriginalClaudeSessionQueries['transcriptReader'];
  readonly sessionStore: () => OriginalClaudeSessionQueries['sessionStore'];
  readonly cwd: () => OriginalClaudeSessionQueries['cwd'];
  readonly attachments: () => OriginalClaudeSessionQueries['attachments'];
  readonly getInternalSessionId: () => OriginalClaudeSessionQueries['getInternalSessionId'];
  readonly resolveLiveProjector: () => OriginalClaudeSessionQueries['resolveLiveProjector'];
  readonly getMessageHistory: () => OriginalClaudeSessionQueries['getMessageHistory'];
  readonly streamProjector: () => OriginalClaudeSessionQueries['streamProjector'];
}

/** Project the original ordered descriptors without invoking any supplied reader during construction. */
export function projectOriginalClaudeSessionQueryView(
  sources: OriginalClaudeSessionQueryProjectionSources
): OriginalClaudeSessionQueries {
  return originalClaudeSessionQueryFreeze<OriginalClaudeSessionQueries>({
    get transcriptReader() {
      return sources.transcriptReader();
    },
    get sessionStore() {
      return sources.sessionStore();
    },
    get cwd() {
      return sources.cwd();
    },
    get attachments() {
      return sources.attachments();
    },
    get getInternalSessionId() {
      const method = sources.getInternalSessionId();
      return (sessionId: string) =>
        originalClaudeSessionQueryApply(method, sources.owner, [sessionId]) as ReturnType<
          typeof method
        >;
    },
    get resolveLiveProjector() {
      const method = sources.resolveLiveProjector();
      return (sessionId: string) =>
        originalClaudeSessionQueryApply(method, sources.owner, [sessionId]) as ReturnType<
          typeof method
        >;
    },
    get getMessageHistory() {
      const method = sources.getMessageHistory();
      return (projectDir: string, sessionId: string) =>
        originalClaudeSessionQueryApply(method, sources.owner, [
          projectDir,
          sessionId,
        ]) as ReturnType<typeof method>;
    },
    get streamProjector() {
      const method = sources.streamProjector();
      return (ctx: SessionOpts, sessionId: string) =>
        originalClaudeSessionQueryApply(method, sources.owner, [ctx, sessionId]) as ReturnType<
          typeof method
        >;
    },
  });
}
