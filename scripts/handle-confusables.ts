/**
 * Prints the handle look-alike table from Unicode's `confusables.txt` (UTS #39),
 * for `apps/server/src/services/rooms/handles/handle-skeleton.ts` (DOR-3156).
 *
 * Keeps only the rows whose source character a handle may contain, so the
 * committed table is the standard's own rows and nothing else. Run it when
 * Unicode publishes a new file, and paste the output over the table and its
 * version:
 *
 *   curl -sO https://www.unicode.org/Public/security/latest/confusables.txt
 *   node scripts/handle-confusables.ts confusables.txt
 */
import { readFileSync } from 'node:fs';

/** Every character the handle grammar allows (`HANDLE_PATTERN`). */
const HANDLE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789._-';

const path = process.argv[2];
if (!path) {
  console.error('Usage: node scripts/handle-confusables.ts <confusables.txt>');
  process.exit(1);
}

const text = readFileSync(path, 'utf8');
const version = /^# Version: (\S+)/m.exec(text)?.[1] ?? 'unknown';
const fromHex = (hex: string): string =>
  hex
    .trim()
    .split(/\s+/)
    .map((point) => String.fromCodePoint(parseInt(point, 16)))
    .join('');

const rows: [string, string][] = [];
for (const line of text.split('\n')) {
  if (line.trim() === '' || line.startsWith('#')) continue;
  const [source, prototype] = line.split(';');
  if (source === undefined || prototype === undefined) continue;
  const from = fromHex(source);
  if (HANDLE_ALPHABET.includes(from)) rows.push([from, fromHex(prototype)]);
}

console.log(`export const CONFUSABLES_VERSION = '${version}';`);
console.log('export const CONFUSABLE_PROTOTYPES = {');
for (const [from, to] of rows) console.log(`  ${JSON.stringify(from)}: ${JSON.stringify(to)},`);
console.log('};');
