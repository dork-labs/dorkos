#!/usr/bin/env node
/**
 * Documentation coverage map helper.
 *
 * Single source of truth for the source-code-path -> docs mapping is
 * `contributing/INDEX.md` (the "Guide Coverage Map", "External Docs Coverage",
 * and "Keyword Triggers" tables). That mapping used to be hand-duplicated in
 * three places (INDEX.md, .claude/hooks/check-docs-changed.sh, and
 * .claude/commands/docs/reconcile.md), which silently drifted. It now lives in
 * one machine-readable file, `.claude/scripts/docs-coverage-map.json`, generated
 * from INDEX.md, and both the Stop hook and /docs:reconcile read it from here.
 *
 * Modes:
 *
 *   node docs-coverage-map.mjs --match <file> [<file> ...]
 *   echo "<files>" | node docs-coverage-map.mjs --match
 *       Given changed file paths (as args or on stdin, one per line), prints the
 *       affected internal guides and external docs. Output is two sections:
 *           GUIDE:contributing/<name>
 *           DOC:<docs/path>
 *       The bash Stop hook parses these lines. Exits 0 always.
 *
 *   node docs-coverage-map.mjs --check
 *       Verifies docs-coverage-map.json agrees with contributing/INDEX.md.
 *       Prints divergences and exits 1 if they disagree, 0 if in sync. Use this
 *       to catch drift after editing INDEX.md (it is the regeneration guard).
 *
 *   node docs-coverage-map.mjs --print
 *       Prints the parsed JSON map (debugging).
 *
 * The JSON is generated from INDEX.md; when you change INDEX.md, regenerate it:
 *   node docs-coverage-map.mjs --regen
 */
import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, '..', '..');
const jsonPath = join(scriptDir, 'docs-coverage-map.json');
const indexPath = join(repoRoot, 'contributing', 'INDEX.md');

const GENERATED_COMMENT =
  'GENERATED FROM contributing/INDEX.md (Guide Coverage Map + External Docs Coverage + Keyword Triggers). ' +
  'Single source of truth is INDEX.md. Regenerate with: node .claude/scripts/docs-coverage-map.mjs --regen. ' +
  'Do NOT hand-edit; edit INDEX.md and regenerate.';

/**
 * Split a pattern cell into its constituent regex patterns on `|`, but only at
 * paren depth 0 — a `|` inside a parenthesised alternation like
 * `commands/(agent|task|activity)` stays part of that one pattern instead of
 * shredding it into unterminated fragments. Table-level `\|` escaping has
 * already been resolved to a literal `|` by the time this runs, so a plain
 * `.split('|')` cannot tell an alternation pipe from a pattern separator;
 * paren depth is the signal that survives.
 */
export function splitPatterns(cell) {
  const patterns = [];
  let current = '';
  let depth = 0;
  for (const ch of cell) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === '|' && depth === 0) {
      patterns.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  patterns.push(current);
  return patterns;
}

/**
 * Parse a pipe-delimited markdown table whose rows are wrapped in backticks and
 * may contain escaped pipes (`\|`) inside the pattern cell.
 */
function parseTable(lines, startMarker, stopMarkers) {
  const rows = [];
  let inSection = false;
  for (const raw of lines) {
    if (raw.startsWith(startMarker)) {
      inSection = true;
      continue;
    }
    if (inSection && stopMarkers.some((s) => raw.startsWith(s))) break;
    if (!inSection) continue;
    const line = raw.trim();
    if (!line.startsWith('|')) continue;
    // Protect escaped pipes, split on table-cell pipes, restore.
    const protectedLine = line.replace(/\\\|/g, '\u0000');
    const cells = protectedLine
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      // replaceAll with a plain string rather than a /…/g regex: same result,
      // and it keeps the sentinel out of a regex literal, where no-control-regex
      // flags it (rightly — a control character in a pattern is nearly always a
      // typo rather than, as here, a deliberate placeholder).
      .map((c) => c.replaceAll('\u0000', '|').trim());
    if (cells.length < 3) continue;
    const first = cells[0].replace(/`/g, '').trim();
    if (first === 'Guide' || first === 'MDX File') continue;
    if (/^[-:\s]+$/.test(cells[0])) continue; // separator row
    const name = first;
    const description = cells[1].trim();
    const pattern = cells[cells.length - 1].replace(/`/g, '').trim();
    rows.push({ name, description, patterns: splitPatterns(pattern) });
  }
  return rows;
}

function parseKeywordTriggers(lines) {
  const rows = [];
  let inSection = false;
  for (const raw of lines) {
    if (raw.startsWith('### Keyword Triggers')) {
      inSection = true;
      continue;
    }
    if (inSection && raw.startsWith('### External Docs Maintenance')) break;
    if (!inSection) continue;
    const line = raw.trim();
    if (!line.startsWith('|')) continue;
    const cells = line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.replace(/`/g, '').trim());
    if (cells.length < 3) continue;
    if (cells[0] === 'Old Term') continue;
    if (/^[-:\s]+$/.test(cells[0])) continue;
    rows.push({ oldTerm: cells[0], newTerm: cells[1], affectedDocs: cells[2] });
  }
  return rows;
}

/** Build the canonical map by parsing INDEX.md. */
function buildFromIndex() {
  const lines = readFileSync(indexPath, 'utf8').split('\n');
  const internal = parseTable(lines, '## Guide Coverage Map', [
    '## Pattern Syntax',
    '## Maintenance',
  ]).map((r) => ({ guide: r.name, description: r.description, patterns: r.patterns }));
  const external = parseTable(lines, '## External Docs Coverage', [
    '### Keyword',
    '### External Docs Maintenance',
  ]).map((r) => ({ doc: r.name, description: r.description, patterns: r.patterns }));
  const keywordTriggers = parseKeywordTriggers(lines);
  return {
    _comment: GENERATED_COMMENT,
    internalGuides: internal,
    externalDocs: external,
    keywordTriggers,
  };
}

/** Load the committed JSON map (the runtime artifact). */
function loadJson() {
  if (!existsSync(jsonPath)) return null;
  try {
    return JSON.parse(readFileSync(jsonPath, 'utf8'));
  } catch {
    return null;
  }
}

function matchFiles(files, map) {
  const guides = new Set();
  const docs = new Set();
  for (const file of files) {
    if (!file) continue;
    for (const { guide, patterns } of map.internalGuides) {
      if (patterns.some((p) => p && safeMatch(file, p))) guides.add(guide);
    }
    for (const { doc, patterns } of map.externalDocs) {
      if (patterns.some((p) => p && safeMatch(file, p))) docs.add(doc);
    }
  }
  return { guides: [...guides], docs: [...docs] };
}

/**
 * Mirror `grep -qE "<pattern>"` semantics against a single path.
 *
 * Swallowing a bad pattern is right HERE and nowhere else: `--match` runs inside
 * a Stop hook, where throwing would take the turn's whole docs reminder down
 * over one broken table cell. The cost is that a broken pattern silently covers
 * nothing, which is exactly how DOR-558's bug survived — so the mode that WRITES
 * the map refuses to emit one. See {@link invalidPatterns}.
 */
function safeMatch(file, pattern) {
  try {
    return new RegExp(pattern).test(file);
  } catch {
    return false;
  }
}

/**
 * Every pattern in a map that could never match anything, with the row it came
 * from.
 *
 * Two kinds, and they fail the same way: a pattern the regex engine refuses
 * (`safeMatch` returns false for every path), and an empty one (`matchFiles`
 * skips it). Either is a guide that has quietly stopped being suggested for the
 * files it owns, and nothing about the output says so — a coverage map is
 * exactly the sort of artifact whose silence reads as "nothing changed".
 *
 * `splitPatterns` is the likeliest source of both: it shreds a cell on
 * paren-depth-0 pipes, so a table cell with unbalanced parens yields fragments
 * like `commands/(agent` — a real `SyntaxError` — and a doubled `||` yields an
 * empty string.
 *
 * @param {{internalGuides: Array<{guide: string, patterns: string[]}>, externalDocs: Array<{doc: string, patterns: string[]}>}} map
 *   A parsed coverage map.
 * @returns {Array<{owner: string, pattern: string, reason: string}>} One entry
 *   per unusable pattern, empty when the map is sound.
 */
export function invalidPatterns(map) {
  const bad = [];
  const rows = [
    ...map.internalGuides.map((r) => ({ owner: `contributing/${r.guide}`, patterns: r.patterns })),
    ...map.externalDocs.map((r) => ({ owner: r.doc, patterns: r.patterns })),
  ];
  for (const { owner, patterns } of rows) {
    for (const pattern of patterns) {
      if (pattern === '' || pattern.trim() === '') {
        bad.push({ owner, pattern, reason: 'empty pattern — it is skipped, so it covers nothing' });
        continue;
      }
      try {
        new RegExp(pattern);
      } catch (error) {
        bad.push({ owner, pattern, reason: error.message });
      }
    }
  }
  return bad;
}

/**
 * Print every unusable pattern and return whether the map is sound.
 *
 * @param {object} map - A parsed coverage map.
 * @returns {boolean} True when every pattern compiles.
 */
function reportPatterns(map) {
  const bad = invalidPatterns(map);
  if (bad.length === 0) return true;
  console.error(
    `contributing/INDEX.md has ${bad.length} pattern(s) that can never match. Fix the table cell — ` +
      'a pattern that does not compile makes its row silently cover nothing:'
  );
  for (const { owner, pattern, reason } of bad) {
    console.error(`  ${owner}: ${JSON.stringify(pattern)} — ${reason}`);
  }
  return false;
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Whether this file was RUN rather than imported.
 *
 * The modes below call `process.exit`, so importing this module to unit-test its
 * parsing would end the test run instead. Resolved through `realpathSync` on
 * both sides because `.claude/` is a symlink in some checkouts, and a plain URL
 * comparison would then read as "imported" and the Stop hook would print
 * nothing at all — a silent failure of exactly the kind this file exists to
 * stop. `main()` is called at the bottom, after every declaration it uses.
 */
function isRunDirectly() {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

/** Run the mode named on the command line. Never returns. */
function main() {
  const args = process.argv.slice(2);
  const mode = args[0] || '--match';

  if (mode === '--regen') {
    const map = buildFromIndex();
    // Validated BEFORE the write, so a broken cell cannot be committed as a
    // generated artifact. `--match` cannot report this: it swallows the
    // failure by design (see safeMatch), which is how DOR-558 lived silently.
    if (!reportPatterns(map)) process.exit(1);
    writeFileSync(jsonPath, JSON.stringify(map, null, 2) + '\n');
    console.log(
      `Regenerated ${jsonPath} from INDEX.md ` +
        `(${map.internalGuides.length} guides, ${map.externalDocs.length} docs, ${map.keywordTriggers.length} keyword triggers).`
    );
    process.exit(0);
  }

  if (mode === '--check') {
    const fromIndex = buildFromIndex();
    const fromJson = loadJson();
    if (!fromJson) {
      console.error(
        'docs-coverage-map.json is missing or unparseable. Run: node .claude/scripts/docs-coverage-map.mjs --regen'
      );
      process.exit(1);
    }
    // Both sides: INDEX.md is where a bad pattern is written, and the committed
    // JSON is what actually gets matched against. In sync with a broken pattern
    // in both is still broken.
    const sound = reportPatterns(fromIndex) && reportPatterns(fromJson);
    const a = JSON.stringify({ ...fromIndex, _comment: undefined });
    const b = JSON.stringify({ ...fromJson, _comment: undefined });
    if (a !== b) {
      console.error(
        'DRIFT: docs-coverage-map.json disagrees with contributing/INDEX.md. ' +
          'Regenerate with: node .claude/scripts/docs-coverage-map.mjs --regen'
      );
      process.exit(1);
    }
    if (!sound) process.exit(1);
    console.log('docs-coverage-map.json is in sync with contributing/INDEX.md.');
    process.exit(0);
  }

  if (mode === '--print') {
    console.log(JSON.stringify(loadJson() || buildFromIndex(), null, 2));
    process.exit(0);
  }

  // Default: --match
  const map = loadJson() || buildFromIndex();
  let files = args.slice(mode === '--match' ? 1 : 0);
  if (files.length === 0) {
    files = readStdin()
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const { guides, docs } = matchFiles(files, map);
  for (const g of guides) console.log(`GUIDE:contributing/${g}`);
  for (const d of docs) console.log(`DOC:${d}`);
  process.exit(0);
}

if (isRunDirectly()) main();
