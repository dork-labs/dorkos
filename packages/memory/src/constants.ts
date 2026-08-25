/**
 * The numbers and names the memory engine is built around.
 *
 * @module memory/constants
 */
import { CONVENTION_DIR, CONVENTION_FILES } from '@dorkos/shared/convention-files';

/**
 * How much memory one agent may keep, in characters (~2K tokens).
 *
 * **Re-exported, not declared.** The number is owned by
 * `@dorkos/shared/convention-files`, beside `SOUL_MAX_CHARS` and
 * `NOPE_MAX_CHARS`, because three surfaces have to agree on it and one of them
 * is a browser: this engine's write refusal, the wire cap on
 * `UpdateAgentConventionsSchema`, and the editor's character counter. It is
 * re-exported here so the engine reads its own limit from its own module rather
 * than reaching across the package for it in five files.
 */
export { MEMORY_MAX_CHARS } from '@dorkos/shared/convention-files';

/**
 * The directory inside an agent's own folder that holds its DorkOS files.
 *
 * The same `.dork` every other convention file lives in, taken from the module
 * that owns it rather than spelled again — a second literal is a second place
 * to change on the day it moves. Taken from `convention-files` rather than from
 * `manifest`, which many server suites mock: an engine constant must not depend
 * on a module a test can replace.
 */
export const MEMORY_DIR_NAME = CONVENTION_DIR;

/** The memory file itself, beside `agent.json`, `SOUL.md` and `NOPE.md`. */
export const MEMORY_FILE_NAME = CONVENTION_FILES.memory;
