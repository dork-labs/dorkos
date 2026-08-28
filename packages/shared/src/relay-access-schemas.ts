/**
 * Zod schemas for Relay access control rules.
 *
 * @module shared/relay-access-schemas
 */
import { z } from 'zod';
import { extendZodWithOpenApiOnce } from './zod-openapi.js';

extendZodWithOpenApiOnce();

// === Access Control ===

export const RelayAccessRuleSchema = z
  .object({
    from: z.string().describe('Subject pattern (supports wildcards)'),
    to: z.string().describe('Subject pattern (supports wildcards)'),
    action: z.enum(['allow', 'deny']),
    priority: z.number().int(),
  })
  .openapi('RelayAccessRule');

export type RelayAccessRule = z.infer<typeof RelayAccessRuleSchema>;
