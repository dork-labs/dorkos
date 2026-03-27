import { z } from 'zod';

/** Zod schema for `extension.json` manifest files. */
export const ExtensionManifestSchema = z.object({
  /** Unique extension identifier (kebab-case). Used as directory name and registry key. */
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/),
  /** Human-readable display name. */
  name: z.string().min(1),
  /** Semver version string. */
  version: z.string().regex(/^\d+\.\d+\.\d+/),
  /** Short description shown in settings UI. */
  description: z.string().optional(),
  /** Author name or identifier. */
  author: z.string().optional(),
  /** Minimum DorkOS version required (semver). If host is older, extension cannot be enabled. */
  minHostVersion: z.string().optional(),
  /** Declares which slots this extension contributes to. Informational only — not enforced. */
  contributions: z.record(z.string(), z.boolean()).optional(),
  /** Reserved for future permission model. */
  permissions: z.array(z.string()).optional(),
});

export type ExtensionManifest = z.infer<typeof ExtensionManifestSchema>;
