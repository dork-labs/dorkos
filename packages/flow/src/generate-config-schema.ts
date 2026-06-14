/**
 * JSON Schema generation for `.agents/flow/config.json`.
 *
 * `buildConfigJsonSchema()` bridges the authoritative {@link FlowConfigSchema}
 * Zod source to a JSON Schema (via `z.toJSONSchema`, mirroring
 * `apps/server/src/services/core/config-manager.ts`). The `scripts/`
 * generator and the unit tests both call this so the on-disk artifact stays
 * in lockstep with the Zod source — there is one bridge, never two.
 *
 * Serialization/formatting (Prettier) lives in `scripts/generate-config-schema.ts`,
 * not here, to keep the engine's runtime surface free of build-tooling deps.
 *
 * @module @dorkos/flow/generate-config-schema
 */

import { z } from 'zod';
import { FlowConfigSchema } from './config-schema.js';

/** Path (relative to the repo root) where the generated artifact lives. */
export const CONFIG_SCHEMA_RELATIVE_PATH = '.agents/flow/config.schema.json';

/**
 * Build the JSON Schema for `.agents/flow/config.json` from the authoritative
 * Zod schema. Uses the same `jsonSchema2019-09` target as the `conf` config
 * bridge so the two generators behave identically.
 *
 * @returns The JSON Schema object, ready to serialize.
 */
export function buildConfigJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(FlowConfigSchema, {
    target: 'jsonSchema2019-09',
  }) as Record<string, unknown>;
}
