import { z } from 'zod';
import { extendZodWithOpenApiOnce } from './zod-openapi.js';
extendZodWithOpenApiOnce();

export const ErrorCategorySchema = z
  .enum([
    'max_turns',
    'execution_error',
    'budget_exceeded',
    'output_format_error',
    'auth_error',
    'model_unavailable',
    'runtime_update_required',
  ])
  .openapi('ErrorCategory');

export type ErrorCategory = z.infer<typeof ErrorCategorySchema>;

export const ErrorEventSchema = z
  .object({
    message: z.string(),
    code: z.string().optional(),
    category: ErrorCategorySchema.optional(),
    details: z.string().optional(),
    /**
     * Why, for a code that has more than one cause: a `credits_unavailable`
     * refusal says which (`folder-sign-in`, `off`, …), so the chat offers only
     * the ways on that fit it.
     */
    reason: z.string().optional(),
    /** Server-authored dispatch identity for exact terminal failure correlation. */
    sourceDispatchId: z.string().min(1).optional(),
  })
  .openapi('ErrorEvent');

export type ErrorEvent = z.infer<typeof ErrorEventSchema>;
