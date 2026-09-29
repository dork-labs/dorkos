/**
 * The wire shapes for an extension waiting for a person to let it run
 * (DOR-2517, spec `flow-multiproject` §5).
 *
 * An installed extension that is not approved to run used to be visible only
 * on its card in Settings → Extensions, so a person who installed a plugin
 * never learned that half of it was waiting on them. The server now lists every
 * such extension (`GET /api/extensions/pending-approvals`) and the Activity
 * inbox asks about each one with a single row. These are the shapes that list
 * and the "Not now" answer travel in.
 *
 * Nothing here is ever used for trust. `sourceLabel` and `why` are display
 * text; which copy a person approved is recorded by the server from its own
 * discovery record, never from anything a client sends back.
 *
 * @module shared/extension-approval-schemas
 */
import { z } from 'zod';
import { extendZodWithOpenApiOnce } from './zod-openapi.js';

extendZodWithOpenApiOnce();

/** One extension waiting for a person to allow it to run. */
export const PendingExtensionApprovalSchema = z
  .object({
    /** Extension id. */
    id: z.string().min(1),
    /** Manifest name, e.g. "Flow". */
    name: z.string().min(1),
    /** Manifest version of the copy that would run. */
    version: z.string().min(1),
    /** Resolved path of that copy; part of the source it would be bound to. */
    path: z.string().min(1),
    /** Plugin folder it came inside, when plugin-carried. */
    plugin: z.string().min(1).nullable(),
    /** The mono source line, e.g. "flow plugin · dork-labs/marketplace". Display only. */
    sourceLabel: z.string(),
    /** Whether it has a server half, which picks the consent copy variant. */
    runsInServer: z.boolean(),
    /** Plain one-liner of what it adds ("It adds a Flow tab"), or null when the manifest does not say. */
    adds: z.string().nullable(),
    /** When this copy was first seen waiting. ISO 8601. Only orders rows. */
    since: z.string(),
    /** The second line: what happens and why, derived from the manifest by the server. */
    why: z.string(),
  })
  .openapi('PendingExtensionApproval');

/** One extension waiting for a person to allow it to run. */
export type PendingExtensionApproval = z.infer<typeof PendingExtensionApprovalSchema>;

/** Response of `GET /api/extensions/pending-approvals`. */
export const PendingExtensionApprovalsResponseSchema = z
  .object({
    /** Every extension that is waiting, oldest first. */
    approvals: z.array(PendingExtensionApprovalSchema),
  })
  .openapi('PendingExtensionApprovalsResponse');

/** Response of `GET /api/extensions/pending-approvals`. */
export type PendingExtensionApprovalsResponse = z.infer<
  typeof PendingExtensionApprovalsResponseSchema
>;

/**
 * Body of `POST /api/extensions/:id/dismiss-approval` ("Not now").
 *
 * The copy the person saw, so an answer to a row that went out of date (the
 * extension moved or updated while it was on screen) is refused with
 * `409 stale_approval` instead of silencing a copy nobody looked at.
 */
export const DismissExtensionApprovalRequestSchema = z
  .object({
    /** The resolved path of the copy the row showed. */
    path: z.string().min(1),
    /** The manifest version of the copy the row showed. */
    version: z.string().min(1),
  })
  .openapi('DismissExtensionApprovalRequest');

/** Body of `POST /api/extensions/:id/dismiss-approval`. */
export type DismissExtensionApprovalRequest = z.infer<typeof DismissExtensionApprovalRequestSchema>;

/** The code a "Not now" answer to an out-of-date row is refused with. */
export const STALE_APPROVAL_CODE = 'stale_approval';
