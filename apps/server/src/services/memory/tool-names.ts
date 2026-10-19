/**
 * The two memory tools' names, in a module with no imports, so the lists that
 * load and auto-allow tools by name can name both without pulling the memory
 * service in.
 *
 * @module server/services/memory/tool-names
 */

/** The tool name `memory.write` is registered under. */
export const MEMORY_WRITE_TOOL_NAME = 'memory_write';

/** The tool name `memory.read` is registered under. */
export const MEMORY_READ_TOOL_NAME = 'memory_read';

/**
 * Both memory tools. One spread keeps a list from naming one and forgetting the
 * other: they share the same jail (the caller's own memory, by identity) and
 * the same reason to need no card.
 */
export const MEMORY_TOOL_NAMES = [MEMORY_WRITE_TOOL_NAME, MEMORY_READ_TOOL_NAME] as const;
