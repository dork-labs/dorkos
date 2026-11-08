/**
 * Which mini apps may read which connected apps (DOR-3547), as the owner's
 * Connections page reads it.
 *
 * A mini app that runs in its own sandbox declares the apps it reads. Each
 * declared app it has no current yes for is **waiting**; each yes it holds is
 * **allowed**, with the account the person picked. Nothing here decides: a
 * card shows a link to the one page that does, and `revoke` takes a yes back.
 *
 * @module shared/mini-app-access-schemas
 */
import { z } from 'zod';
import { extendZodWithOpenApiOnce } from './zod-openapi.js';

extendZodWithOpenApiOnce();

/**
 * Why a declared app waits for a person.
 *
 * - `new`: nobody has said yes yet.
 * - `files_changed`: the mini app's code changed since the yes.
 * - `operations_changed`: it now declares other reads than the ones approved.
 */
export const MiniAppAccessWaitReasonSchema = z
  .enum(['new', 'files_changed', 'operations_changed'])
  .openapi('MiniAppAccessWaitReason');

/** Why a declared app waits for a person. */
export type MiniAppAccessWaitReason = z.infer<typeof MiniAppAccessWaitReasonSchema>;

/** One app a mini app declares and may not read yet. */
export const MiniAppAccessWaitingSchema = z
  .object({
    extensionId: z.string(),
    /** The mini app's name, from its manifest. */
    extensionName: z.string(),
    /** The connected app's service id, such as `linear`. */
    service: z.string(),
    /** The read operations it declares for that app. */
    operations: z.array(z.string()),
    reason: MiniAppAccessWaitReasonSchema,
  })
  .openapi('MiniAppAccessWaiting');

/** One app a mini app declares and may not read yet. */
export type MiniAppAccessWaiting = z.infer<typeof MiniAppAccessWaitingSchema>;

/** One live yes: a mini app may read one account. */
export const MiniAppAccessAllowedSchema = z
  .object({
    approvalId: z.string(),
    extensionId: z.string(),
    /** The mini app's name, or its id when it is no longer installed here. */
    extensionName: z.string(),
    service: z.string(),
    connectionId: z.string(),
    /** The account's name, as the Connections page shows it. */
    connectionLabel: z.string(),
    /** When the person said yes, as ISO 8601. */
    approvedAt: z.string(),
  })
  .openapi('MiniAppAccessAllowed');

/** One live yes: a mini app may read one account. */
export type MiniAppAccessAllowed = z.infer<typeof MiniAppAccessAllowedSchema>;

/** `GET /api/connectors/mini-app-access`. */
export const MiniAppAccessListSchema = z
  .object({
    waiting: z.array(MiniAppAccessWaitingSchema),
    allowed: z.array(MiniAppAccessAllowedSchema),
  })
  .openapi('MiniAppAccessList');

/** `GET /api/connectors/mini-app-access`. */
export type MiniAppAccessList = z.infer<typeof MiniAppAccessListSchema>;

/** Path parameters of `POST /api/connectors/mini-app-access/{approvalId}/revoke`. */
export const MiniAppAccessRevokeParamsSchema = z
  .object({ approvalId: z.string().min(1) })
  .openapi('MiniAppAccessRevokeParams');

/** The answer once a yes is taken back. The mini app's next read is refused. */
export const MiniAppAccessRevokeResponseSchema = z
  .object({ status: z.literal('revoked'), approvalId: z.string() })
  .openapi('MiniAppAccessRevokeResponse');

/** The answer once a yes is taken back. */
export type MiniAppAccessRevokeResponse = z.infer<typeof MiniAppAccessRevokeResponseSchema>;
