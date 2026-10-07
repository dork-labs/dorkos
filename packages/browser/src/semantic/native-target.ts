import { z } from 'zod';
import {
  SemanticSnapshotV1Schema,
  SemanticIdentityV1Schema,
} from '@dorkos/shared/browser-semantic-schemas';

/** Private original reader result. Native IDs locate data; control grants independently authorize effects. */
export const NativeSemanticTargetSchema = z
  .object({
    identity: SemanticIdentityV1Schema,
    nodeRef: z.string().regex(/^[A-Za-z0-9_-]{22,64}$/),
    frameId: z.string().regex(/^[A-Za-z0-9_-]{22,64}$/),
    frameNavigationGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    nativeFrameId: z.string().min(1).max(128),
    nativeTargetId: z.string().min(1).max(128),
    /** Candidate position only; the exact original frame session/native target is independently revalidated. */
    nativeFrameSlot: z.number().int().nonnegative().max(31).optional(),
    backendNodeId: z.number().int().positive().max(2147483647),
    documentBackendNodeId: z.number().int().positive().max(2147483647),
    role: z.string().min(1).max(64),
    name: z.string().max(1024),
    kind: z.enum(['none', 'plainText', 'secret']),
    disabled: z.boolean(),
    readonly: z.boolean(),
    focused: z.boolean(),
    focusRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type NativeSemanticTarget = z.infer<typeof NativeSemanticTargetSchema>;
/** Actual original dirty counter only; it carries no page content or new action lease. */
export const NativeSemanticChangesSchema = z
  .object({
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    dirty: z.boolean(),
  })
  .strict();

/** Private correlated continuation; values remain inside the existing sanitized snapshot schema. */
export const NativeSemanticEditResultSchema = z
  .object({
    snapshot: SemanticSnapshotV1Schema,
    target: NativeSemanticTargetSchema.nullable(),
    correlated: z.boolean(),
  })
  .strict()
  .refine((value) => value.correlated === (value.target !== null));
