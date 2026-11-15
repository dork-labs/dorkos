/** Notices returned when a chat starts with fewer tools than the caller may expect. */
import { z } from 'zod';
import { extendZodWithOpenApiOnce } from './zod-openapi.js';

extendZodWithOpenApiOnce();

/** A tool-availability warning; it grants no identity or access. */
export const SessionLaunchWarningSchema = z
  .object({
    code: z.literal('NO_DORKOS_TOOLS'),
    message: z.string(),
  })
  .openapi('SessionLaunchWarning');

/** One warning a start result or an opened chat carries. */
export type SessionLaunchWarning = z.infer<typeof SessionLaunchWarningSchema>;

/** The same optional warnings on a chat, HTTP receipt, and extension start. */
export const SessionLaunchWarningShape = {
  warnings: z.array(SessionLaunchWarningSchema).optional(),
};

/**
 * A chat that had its DorkOS tools and lost them partway through (`lost`),
 * or got them back after (`back`, until the next message). Null once neither
 * holds. Set only from the server's own record of the tool-list answer.
 */
export const SessionDorkosToolsSchema = z
  .enum(['lost', 'back'])
  .nullable()
  .openapi('SessionDorkosTools');

/** Whether a chat lost its DorkOS tools, or got them back. */
export type SessionDorkosTools = z.infer<typeof SessionDorkosToolsSchema>;

/** The new chat and any warning the extension should show with its Watch link. */
export const StartWorkResponseSchema = z
  .object({
    sessionId: z.string(),
    ...SessionLaunchWarningShape,
  })
  .openapi('StartWorkResponse');

/** Response of an extension's start-work request. */
export type StartWorkResponse = z.infer<typeof StartWorkResponseSchema>;

/** Receipt fields independent of the message-disposition schema. */
export const SendMessageReceiptSchema = z.object({
  sessionId: z
    .string()
    .describe('Canonical session id; differs from the request id for a new session'),
  messageId: z.string().describe('Server-minted id for this message; the queue is keyed by it'),
  queuePosition: z
    .number()
    .int()
    .positive()
    .describe('1-based place in the session queue at acceptance; 1 means nothing was ahead of it'),
  ...SessionLaunchWarningShape,
});
