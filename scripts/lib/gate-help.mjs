/**
 * Every gate's `--help` (DOR-4950): the block of its own header comment between
 * a line reading `--help` and a line reading `--help end`, printed with the
 * comment markers taken off.
 *
 * The header is the gate's document of record, so the help lives there and
 * nowhere else: `contributing/ci.md` links to `<gate> --help` instead of
 * restating it. Each block says what the gate is for (`Purpose:`), where it
 * runs (`Runs in:`), how to fix a failure or update its baseline (`To fix:`)
 * and how to call it (`Usage:`). `scripts/__tests__/gate-help.test.ts` holds
 * every gate to that. Bash gates source `gate-help.sh` beside this file, which
 * reads the same block the same way.
 *
 * Plain JavaScript, like `space-server.mjs` beside it, so `.ts` gates under
 * node or tsx and `.mjs` gates import the same reader.
 *
 * @module scripts/lib/gate-help
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** One comment marker and the space after it: `#`, `//` or a JSDoc `*`. */
const COMMENT = /^\s*(?:#|\/\/|\*)\s?/;

/**
 * The `--help` block of a gate's source, without its comment markers, ending
 * in a newline. Empty when the source has no block.
 *
 * @param {string} source - The gate's source text.
 * @returns {string}
 */
export function readGateHelp(source) {
  const out = [];
  let inside = false;
  for (const raw of source.split('\n')) {
    const line = raw.replace(COMMENT, '').trimEnd();
    if (inside && line === '--help end') return `${out.join('\n')}\n`;
    if (inside) out.push(line);
    if (line === '--help') inside = true;
  }
  return '';
}

/**
 * When the gate's first argument (after a leading `--`) is `--help` or `-h`,
 * print its `--help` block and exit 0, before the gate does any work.
 * Otherwise return and let the gate run.
 *
 * @param {string} scriptUrl - The gate's `import.meta.url`.
 * @param {string[]} [argv] - The gate's arguments; defaults to the process's.
 */
export function exitOnHelp(scriptUrl, argv = process.argv.slice(2)) {
  const first = argv[0] === '--' ? argv[1] : argv[0];
  if (first !== '--help' && first !== '-h') return;
  process.stdout.write(readGateHelp(readFileSync(fileURLToPath(scriptUrl), 'utf8')));
  process.exit(0);
}
