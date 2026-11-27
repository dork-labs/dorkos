/**
 * The pages the mini app lists answer with (DOR-4982): the installed mini
 * apps, those waiting for a first yes, the approvals left behind, and the
 * plugins whose mini apps wait together. Each is `{ <plural noun>: [...],
 * nextCursor }`, `cursor` and `limit` in the query (`@dorkos/shared/paging`).
 *
 * @module shared/extension-list-schemas
 */
import { z } from 'zod';
import { extendZodWithOpenApiOnce } from './zod-openapi.js';
import { nextCursorOutput } from './paging.js';
import {
  ExtensionApprovalSetSchema,
  PendingExtensionApprovalSchema,
} from './extension-approval-schemas.js';

extendZodWithOpenApiOnce();

/**
 * One installed mini app as `GET /api/extensions` lists it: the fields every
 * caller reads, named; the rest of `ExtensionRecordPublic`
 * (`@dorkos/extension-api`) passes through.
 */
export const ExtensionListItemSchema = z
  .object({
    id: z.string().describe('The mini app’s id.'),
    manifest: z
      .object({ id: z.string(), name: z.string(), version: z.string() })
      .passthrough()
      .describe('Its `extension.json`, as read.'),
    status: z
      .enum([
        'discovered',
        'incompatible',
        'invalid',
        'disabled',
        'enabled',
        'compiled',
        'compile_error',
        'active',
        'activate_error',
      ])
      .describe('Where it stands, from found to running.'),
    scope: z.enum(['global', 'local']),
    origin: z.enum(['core', 'user']).describe('Whether it ships with DorkOS or was installed.'),
    approvedToRun: z.boolean().describe('Whether a person allowed it to run code in DorkOS.'),
    bundleReady: z.boolean(),
    shadowedBy: z
      .string()
      .nullable()
      .describe(
        'The path of the newer copy that runs instead of this one; null for one that runs.'
      ),
  })
  .passthrough()
  .openapi('ExtensionListItem');

/** One page of `GET /api/extensions`. */
export const ExtensionListPageSchema = z
  .object({ extensions: z.array(ExtensionListItemSchema), nextCursor: nextCursorOutput })
  .openapi('ExtensionListPage');

/** One page of `GET /api/extensions/pending-approvals`, newest waiting first. */
export const PendingExtensionApprovalsPageSchema = z
  .object({ approvals: z.array(PendingExtensionApprovalSchema), nextCursor: nextCursorOutput })
  .openapi('PendingExtensionApprovalsPage');

/** One page of `GET /api/extensions/pending-approvals`. */
export type PendingExtensionApprovalsPage = z.infer<typeof PendingExtensionApprovalsPageSchema>;

/** One approval whose mini app is no longer installed anywhere (DOR-3372). */
export const StaleExtensionApprovalSchema = z
  .object({
    id: z.string().describe('The extension id the approval names.'),
    path: z
      .string()
      .nullable()
      .describe('The folder the approval was given to; null for a caller that is not the person.'),
    plugin: z.string().nullable().describe('The plugin that carried it, when it came inside one.'),
  })
  .openapi('StaleExtensionApproval');

/** One approval whose mini app is gone. */
export type StaleExtensionApproval = z.infer<typeof StaleExtensionApprovalSchema>;

/** One page of `GET /api/extensions/stale-approvals`. */
export const StaleExtensionApprovalsPageSchema = z
  .object({ approvals: z.array(StaleExtensionApprovalSchema), nextCursor: nextCursorOutput })
  .openapi('StaleExtensionApprovalsPage');

/** One page of `GET /api/extensions/approval-sets`. */
export const ExtensionApprovalSetsPageSchema = z
  .object({ sets: z.array(ExtensionApprovalSetSchema), nextCursor: nextCursorOutput })
  .openapi('ExtensionApprovalSetsPage');
