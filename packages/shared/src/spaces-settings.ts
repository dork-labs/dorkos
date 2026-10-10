/**
 * The `spaces` config block and the community ref it shares with saved navigation (DOR-2740,
 * spec `official-community-space` D4). Imported by `config-schema.ts`, which documents the
 * block where callers read it.
 *
 * Schemas only, for the reason `config-schema.ts` gives at its top.
 *
 * @module spaces-settings
 */
import { z } from 'zod';

/** A local space connection ref, as saved navigation stores it: path-safe. */
export const CommunityNavigationRefSchema = z
  .string()
  .regex(/^[0-9A-Za-z][0-9A-Za-z_-]*$/, 'A community ref must be path-safe');

/**
 * `spaces`: the experiment (`enabled`, off by default) and the official DorkOS space's link
 * (`official.url`, `''` for none). See `UserConfigSchema.spaces` for what each means.
 */
export const SpacesSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    official: z.object({ url: z.string().max(2048).default('') }).default(() => ({ url: '' })),
  })
  .default(() => ({ enabled: false, official: { url: '' } }));
