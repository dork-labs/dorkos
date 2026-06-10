/**
 * Maps recoverable pending-interaction DTOs back to their native SSE
 * `StreamEvent`s for the Path B re-emit on persistent-stream connect.
 *
 * @module lib/pending-interaction-events
 */
import type { PendingInteractionDTO, StreamEvent } from '@dorkos/shared/types';
import { SESSIONS } from '../config/constants.js';

/**
 * Rebuild the native SSE `StreamEvent` for a recoverable pending interaction
 * (Path B re-emit). Maps a `PendingInteractionDTO` back to the same `data`
 * shape the in-band `canUseTool` handler first emitted, mirroring `dto.id` onto
 * the type-specific routing field (`toolCallId` for approvals/questions,
 * `interactionId` for elicitations) and carrying the server-authoritative
 * `remainingMs` so the client countdown resumes without resetting. The emitted
 * event NAME matches the DTO's native type (`approval_required`,
 * `question_prompt`, `elicitation_prompt`) so the client's existing
 * `syncEventHandlers` route it through the same idempotent renderer.
 *
 * @param dto - A non-expired pending interaction from `getPendingInteractions`.
 * @returns The `StreamEvent` to write on the persistent sync stream.
 */
export function pendingInteractionToStreamEvent(dto: PendingInteractionDTO): StreamEvent {
  switch (dto.type) {
    case 'approval':
      return {
        type: 'approval_required',
        data: {
          toolCallId: dto.id,
          toolName: dto.toolName,
          input: dto.input,
          timeoutMs: SESSIONS.INTERACTION_TIMEOUT_MS,
          startedAt: dto.startedAt,
          remainingMs: dto.remainingMs,
          hasSuggestions: dto.hasSuggestions,
          ...(dto.title !== undefined && { title: dto.title }),
          ...(dto.displayName !== undefined && { displayName: dto.displayName }),
          ...(dto.description !== undefined && { description: dto.description }),
          ...(dto.blockedPath !== undefined && { blockedPath: dto.blockedPath }),
          ...(dto.decisionReason !== undefined && { decisionReason: dto.decisionReason }),
        },
      };
    case 'question':
      return {
        type: 'question_prompt',
        data: {
          toolCallId: dto.id,
          questions: dto.questions,
          startedAt: dto.startedAt,
          remainingMs: dto.remainingMs,
        },
      };
    case 'elicitation':
      return {
        type: 'elicitation_prompt',
        data: {
          interactionId: dto.id,
          serverName: dto.serverName,
          message: dto.message,
          timeoutMs: SESSIONS.INTERACTION_TIMEOUT_MS,
          startedAt: dto.startedAt,
          remainingMs: dto.remainingMs,
          ...(dto.mode !== undefined && { mode: dto.mode }),
          ...(dto.url !== undefined && { url: dto.url }),
          ...(dto.elicitationId !== undefined && { elicitationId: dto.elicitationId }),
          ...(dto.requestedSchema !== undefined && { requestedSchema: dto.requestedSchema }),
        },
      };
  }
}
