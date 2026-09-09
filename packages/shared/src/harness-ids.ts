/**
 * The agent harness ids, and nothing else.
 *
 * A leaf on purpose: it imports nothing, exports one frozen tuple of strings,
 * and holds no Zod schema, no class and no value whose identity anybody
 * compares. That is the whole reason it exists as its own module.
 *
 * ## Why it is not simply in `harness-schemas.ts`
 *
 * `apps/server/vitest.config.ts` aliases five `@dorkos/shared/*` subpaths to
 * SRC — `config-schema` among them — for every vitest project in the repo, so a
 * test process legitimately holds both the `src` and the `dist` copy of those
 * modules. That is safe only while such a module exports "Zod schemas, plain
 * constants, and pure functions … nothing whose identity is ever compared", and
 * the alias comment says in so many words not to widen it without re-measuring.
 *
 * A Zod schema's identity IS compared, by the one thing that matters here: the
 * `.openapi()` method `@asteasolutions/zod-to-openapi` patches onto zod's
 * prototype. When `config-schema.ts` imported `HarnessIdSchema` from
 * `harness-schemas.ts`, the SRC copy of `config-schema` pulled in a SRC copy of
 * `harness-schemas`, built on the zod instance vite inlines — while
 * `openapi-registry.ts` registered the DIST `HarnessStatusResponseSchema`,
 * built on the other one. The patch landed on one prototype and the registry
 * asked the other, and `registry.register('HarnessStatusResponse', …)` threw
 * `TypeError: zodSchema.openapi is not a function` from inside the package,
 * naming a line in the registry rather than the import that caused it
 * (DOR-1924, measured on `packages/evals`, whose test project reaches `app.ts`).
 *
 * So `config-schema.ts` builds its own `z.enum(HARNESS_IDS)` from these
 * constants instead. Two copies of a string tuple are harmless: nothing ever
 * asks whether two arrays of ids are the same array, only what is in them.
 *
 * `harness-schemas.ts` re-exports {@link HARNESS_IDS}, so every existing
 * importer keeps working and there is still exactly one definition.
 *
 * @module harness-ids
 */

/**
 * The agent harnesses Harness Sync can project to. Claude Code is the canonical
 * authoring harness; the rest are projection targets.
 *
 * The ORDER is load-bearing: several surfaces list harnesses in it so that two
 * readers of one machine name the same tools in the same sequence.
 */
export const HARNESS_IDS = [
  'claude-code',
  'codex',
  'cursor',
  'gemini',
  'copilot',
  'opencode',
] as const;

/** A supported agent harness identifier. */
export type HarnessId = (typeof HARNESS_IDS)[number];
