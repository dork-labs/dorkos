/**
 * The journey fixture kit — `@dorkos/harness/journeys`.
 *
 * A journey is one contract scenario (`meta/harness-sync-capabilities.md` §12)
 * staged as a real repository, run once, and asserted as an EXACT before/after
 * tree diff. Half of them are engine-only and live beside this file; the other
 * half need the server seam (`runAutoProjection`, `projectWithConsent`,
 * `projectAgentWorkspace`) and live in
 * `apps/server/src/services/harness/__tests__/journeys/`.
 *
 * That split is the only reason this barrel is in the package's `exports` map.
 * A fixture kit shared by two packages has to be reachable from both, and the
 * alternatives were worse: a relative import climbing seven directories out of
 * `apps/server`, or a copy of the DSL that would drift the day one journey
 * learned something the other did not. It is deliberately a **test-only**
 * entry point — `tsconfig.build.json` excludes `__tests__`, so nothing here is
 * compiled into `dist/` and no production module may import it.
 *
 * @module __tests__/journeys
 */
export * from './stage.js';
export * from './stage-repo.js';
