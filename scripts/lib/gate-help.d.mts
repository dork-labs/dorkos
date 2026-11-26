/**
 * Types for `gate-help.mjs`, which prints a gate's `--help` block from its own
 * header comment (DOR-4950). See that file for the block's shape.
 *
 * @module scripts/lib/gate-help
 */

/**
 * The `--help` block of a gate's source, without its comment markers, ending
 * in a newline. Empty when the source has no block.
 *
 * @param source - The gate's source text.
 */
export function readGateHelp(source: string): string;

/**
 * When the gate's first argument (after a leading `--`) is `--help` or `-h`,
 * print its `--help` block and exit 0, before the gate does any work.
 *
 * @param scriptUrl - The gate's `import.meta.url`.
 * @param argv - The gate's arguments; defaults to the process's.
 */
export function exitOnHelp(scriptUrl: string, argv?: string[]): void;
