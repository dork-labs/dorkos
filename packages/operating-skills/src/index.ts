/**
 * `@dorkos/operating-skills` — the Operating DorkOS skill pack.
 *
 * The canonical, in-repo skills that teach an agent how to run DorkOS, plus a
 * version-stamped, idempotent seeder. Importable without a server by both the
 * server (agent creation, DorkBot boot) and the CLI; pure Node, no server or
 * browser dependencies.
 *
 * @module @dorkos/operating-skills
 */
export { OPERATING_SKILLS_PACK, OPERATING_SKILLS_VERSION, type OperatingSkill } from './pack.js';
export { seedOperatingSkills, type SeedAction, type SeedOutcome, type SeedResult } from './seed.js';
