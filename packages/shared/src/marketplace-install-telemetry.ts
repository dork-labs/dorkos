/**
 * The wire format of one marketplace install telemetry event: what the DorkOS
 * server POSTs to `https://dorkos.ai/api/telemetry/install` after an install,
 * uninstall or update finishes.
 *
 * One definition for both sides: the site's Edge route validates every request
 * against {@link InstallTelemetryEventSchema}, and the server's reporter test
 * parses the payload it really builds against the same schema, so a field the
 * route requires can never again go missing on the send side unnoticed
 * (DOR-4988). Pure Zod, so it runs on the Edge runtime.
 *
 * Adding a field here is the only way new data can land in the site's
 * `marketplace_install_events` table: keep it and the site's Drizzle table in
 * lockstep, and never add a header-derived or PII-shaped field
 * (`contributing/marketplace-telemetry.md` §7).
 *
 * @module marketplace-install-telemetry
 */

import { z } from 'zod';

const MAX_NAME_LEN = 64;
const MAX_ERROR_CODE_LEN = 64;
const MAX_VERSION_LEN = 32;
const MAX_DURATION_MS = 600_000;

/**
 * The marketplace source forms a package can be installed from: a bare
 * `./name` path inside the marketplace clone, or one of the object forms
 * `github`, `url`, `git-subdir` and `npm`.
 */
export const INSTALL_TELEMETRY_SOURCE_TYPES = [
  'relative-path',
  'github',
  'url',
  'git-subdir',
  'npm',
] as const;

/** One of {@link INSTALL_TELEMETRY_SOURCE_TYPES}. */
export type InstallTelemetrySourceType = (typeof INSTALL_TELEMETRY_SOURCE_TYPES)[number];

/**
 * The package types an install event may carry: the same five as
 * `PackageTypeSchema` in `@dorkos/marketplace`, in the same order. They are
 * listed here rather than imported because `@dorkos/marketplace` depends on this
 * package (through `@dorkos/extension-api`), so importing it back would make a
 * cycle. Two guards keep the copies equal: the server's reporter assigns a
 * marketplace `PackageType` to this type, so a new marketplace type fails to
 * compile until it is added here, and the reporter's test compares the two
 * lists. Before DOR-4988 this list lacked `shape`, so every shape install was
 * refused.
 */
export const INSTALL_TELEMETRY_PACKAGE_TYPES = [
  'agent',
  'plugin',
  'skill-pack',
  'adapter',
  'shape',
] as const;

/** One of {@link INSTALL_TELEMETRY_PACKAGE_TYPES}. */
export type InstallTelemetryPackageType = (typeof INSTALL_TELEMETRY_PACKAGE_TYPES)[number];

/**
 * One install telemetry event as it travels on the wire. `installId` is the
 * anonymous per-machine id, never a user id.
 */
export const InstallTelemetryEventSchema = z.object({
  packageName: z.string().min(1).max(MAX_NAME_LEN),
  marketplace: z.string().min(1).max(MAX_NAME_LEN),
  type: z.enum(INSTALL_TELEMETRY_PACKAGE_TYPES),
  outcome: z.enum(['success', 'failure', 'cancelled']),
  durationMs: z.number().int().min(0).max(MAX_DURATION_MS),
  errorCode: z.string().max(MAX_ERROR_CODE_LEN).optional(),
  installId: z.string().uuid(),
  dorkosVersion: z.string().min(1).max(MAX_VERSION_LEN),
  sourceType: z.enum(INSTALL_TELEMETRY_SOURCE_TYPES),
});

/** A validated install telemetry event. */
export type InstallTelemetryEvent = z.infer<typeof InstallTelemetryEventSchema>;
