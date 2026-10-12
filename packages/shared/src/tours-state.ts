/**
 * The `tours` config block: which DorkBot tours a person has run or declined.
 * Imported and re-exported by `config-schema.ts`, which places it in the config.
 *
 * Schemas only, for the reason `config-schema.ts` gives at its top.
 *
 * @module tours-state
 */
import { z } from 'zod';

/**
 * Persisted state for the DorkBot living tour (DOR-419). Tracks which tours the
 * user has already run (`seen`) and which they declined (`declined`) so an
 * occasion never re-offers a tour the user has finished or waved off. Ids are the
 * tour definition ids (`'tasks' | 'relay' | 'mesh' | 'general'`), stored as free
 * strings so adding a tour never needs a schema migration. Managed automatically
 * by the client; not user-editable.
 */
export const ToursStateSchema = z.object({
  seen: z.array(z.string()).default(() => []),
  declined: z.array(z.string()).default(() => []),
});

export type ToursState = z.infer<typeof ToursStateSchema>;

/** Frozen defaults for the {@link ToursStateSchema} block (empty on a fresh install). */
export const TOURS_DEFAULTS: ToursState = ToursStateSchema.parse({});
