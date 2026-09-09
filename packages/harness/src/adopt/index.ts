/**
 * `adopt` — moving one skill out of an agent tool's own folder into the
 * canonical layer, on purpose and never by surprise.
 *
 * Two halves: {@link readAdoptCandidates} establishes the facts about a
 * repository, and {@link planAdopt} decides over them without touching a disk.
 * Everything a person reads about a refusal comes from `refusals.ts`, and the
 * one question of what is safe to share is answered in `allowlist.ts` and
 * nowhere else.
 *
 * @module adopt
 */
export * from './types.js';
export * from './allowlist.js';
export * from './refusals.js';
export * from './plan.js';
export * from './read.js';
export * from './apply.js';
