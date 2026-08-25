/**
 * The numbers and names the memory engine is built around.
 *
 * @module memory/constants
 */

/**
 * How much memory one agent may keep, in characters (~2K tokens).
 *
 * The cap is not storage thrift — a markdown file could be a megabyte and
 * nobody would notice on disk. It is a **prompt** budget, and it is the reason
 * the worst case of this feature is knowable. On claude-code the memory block
 * rides the cached system prompt, so it costs this much once per cache lifetime;
 * on codex and opencode the agent-context append is re-sent verbatim on every
 * single turn, uncached, so a full memory file is roughly 10 KB per turn, every
 * turn, forever. An uncapped file would make that unbounded on two of three
 * runtimes.
 *
 * Writes that would cross it are refused with an error that says how to fix it
 * (`MemoryCapExceededError`), never trimmed silently. A file already over the
 * cap — only reachable by editing it on disk — still reads, truncated, with a
 * visible warning.
 */
export const MEMORY_MAX_CHARS = 8_000;

/** The directory inside an agent's own folder that holds its DorkOS files. */
export const MEMORY_DIR_NAME = '.dork';

/** The memory file itself, beside `agent.json`, `SOUL.md` and `NOPE.md`. */
export const MEMORY_FILE_NAME = 'MEMORY.md';
