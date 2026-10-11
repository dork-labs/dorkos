/**
 * Read a page of any runtime's transcript for `transcript_read` (spec
 * `audit-trail` §6.4).
 *
 * The same read `GET /api/sessions/:id/messages` makes (resolve the runtime,
 * its internal id and the session's directory, then ask the runtime for its
 * history with the kickoff turn removed), returned in a smaller shape: tool
 * inputs and results are kept, because reviewing an agent's work is what the
 * tool is for, but each is cut to a readable length.
 *
 * @module services/audit/read-transcript
 */
import { filterKickoffHistory } from '@dorkos/shared/kickoff';
import type { RuntimeRegistry } from '../core/runtime-registry.js';
import { resolveSessionCwdOrNull } from '../session/resolution/resolve-read-cwd.js';
import type { TranscriptPage } from '@dorkos/shared/audit-schemas';

/** The longest message text, tool input or tool result a page carries. */
const MAX_FIELD = 8_000;

/** Cut a long string, marking that it was cut. */
function clip(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.length <= MAX_FIELD ? value : `${value.slice(0, MAX_FIELD - 1)}…`;
}

/**
 * Build the transcript reader the audit capabilities use.
 *
 * @param registry - The runtime registry, to find the session's runtime.
 * @returns A reader that answers `undefined` for a session it cannot read.
 */
export function createTranscriptReader(
  registry: Pick<RuntimeRegistry, 'resolveForSession'>
): (
  sessionId: string,
  page: { offset: number; limit: number }
) => Promise<TranscriptPage | undefined> {
  return async (sessionId, page) => {
    try {
      const runtime = await registry.resolveForSession(sessionId);
      const cwd = await resolveSessionCwdOrNull(runtime, sessionId, undefined);
      if (!cwd) return undefined;
      const internalId = runtime.getInternalSessionId(sessionId) ?? sessionId;
      const messages = filterKickoffHistory(await runtime.getMessageHistory(cwd, internalId));
      return {
        total: messages.length,
        messages: messages.slice(page.offset, page.offset + page.limit).map((message) => ({
          id: message.id,
          role: message.role,
          content: clip(message.content) ?? '',
          ...(message.timestamp ? { timestamp: message.timestamp } : {}),
          ...(message.toolCalls?.length
            ? {
                toolCalls: message.toolCalls.map((call) => ({
                  toolName: call.toolName,
                  status: call.status,
                  ...(call.input !== undefined ? { input: clip(call.input) } : {}),
                  ...(call.result !== undefined ? { result: clip(call.result) } : {}),
                })),
              }
            : {}),
        })),
      };
    } catch {
      return undefined;
    }
  };
}
