#!/usr/bin/env node
// Refreshes the money-word candidates that
// packages/connector-providers/src/composio/__tests__/money-word-pin.test.ts
// pins (DOR-4624). It lists every Composio app's actions, keeps each one whose
// name or description says it may move money (the shared tight matcher in
// __tests__/helpers/money-words.ts) and that is not a read, and writes them,
// sorted by app then action, with their safety hints and full descriptions.
//
// Makes read-only catalog calls only: `composio dev toolkits list` to find the
// apps and `composio tools list <app>` for their actions. It never runs an
// action. Needs the `composio` CLI signed in, unless `--from` names a saved
// catalog (`{ <app>: [{ slug, tags, description }] }`); then pass
// `--checked-at` with the day that catalog was pulled.
//
// tsx resolves the `.js` imports inside the TypeScript sources it loads:
//
//   pnpm exec tsx scripts/composio-money-word-candidates.mjs \
//     [--from catalog.json --checked-at YYYY-MM-DD] [out.json]
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { format, resolveConfig } from 'prettier';
import { classifyComposioAction } from '../packages/connector-providers/src/composio/action-classes.ts';
import { matchesMoneyWords } from '../packages/connector-providers/src/composio/__tests__/helpers/money-words.ts';

const run = promisify(execFile);
const { values, positionals } = parseArgs({
  options: { from: { type: 'string' }, 'checked-at': { type: 'string' } },
  allowPositionals: true,
});
const outFile =
  positionals[0] ??
  fileURLToPath(
    new URL(
      '../packages/connector-providers/src/composio/__tests__/fixtures/money-word-candidates.json',
      import.meta.url
    )
  );

async function composio(args) {
  const { stdout } = await run('composio', args, {
    maxBuffer: 256 * 1024 * 1024,
    timeout: 120_000,
  });
  return JSON.parse(stdout);
}

/**
 * Every app with at least one action. One list call stops at 1000 apps, so
 * this also asks per letter and digit, and splits any query that hits the cap.
 */
async function listToolkits() {
  const found = new Map();
  const capped = [];
  async function ask(query) {
    const args = ['dev', 'toolkits', 'list', '--limit', '1000'];
    const page = await composio(query ? [...args, '--query', query] : args);
    for (const toolkit of page) found.set(toolkit.slug, toolkit.tools_count ?? 0);
    if (page.length >= 1000) capped.push(query);
  }
  await ask('');
  capped.length = 0;
  const queries = [...'abcdefghijklmnopqrstuvwxyz0123456789'];
  while (queries.length) {
    await ask(queries.shift());
    while (capped.length) {
      const query = capped.shift();
      queries.push(...[...'abcdefghijklmnopqrstuvwxyz0123456789_'].map((next) => query + next));
    }
  }
  return [...found]
    .filter(([, count]) => count > 0)
    .map(([slug]) => slug)
    .sort();
}

/** Every app's actions, three apps at a time, as `{ <app>: [{ slug, tags, description }] }`. */
async function pullCatalog() {
  const queue = await listToolkits();
  const catalog = {};
  const failed = [];
  async function worker() {
    for (let toolkit = queue.shift(); toolkit; toolkit = queue.shift()) {
      try {
        const tools = await composio(['tools', 'list', toolkit, '--limit', '1000']);
        catalog[toolkit] = tools.map((tool) => ({
          slug: tool.slug,
          tags: tool.tags ?? [],
          description: tool.description ?? '',
        }));
      } catch (error) {
        failed.push(`${toolkit}: ${String(error.message).slice(0, 160)}`);
      }
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  if (failed.length) {
    // A missing app would quietly drop its rows from the fixture; refuse instead.
    throw new Error(`could not list ${failed.length} apps:\n${failed.join('\n')}`);
  }
  return catalog;
}

const catalog = values.from ? JSON.parse(readFileSync(values.from, 'utf8')) : await pullCatalog();

let actions = 0;
const toolkits = {};
for (const toolkit of Object.keys(catalog).sort()) {
  const rows = [];
  for (const action of catalog[toolkit]) {
    actions += 1;
    const tags = (action.tags ?? []).filter((tag) => tag.endsWith('Hint'));
    const description = action.description ?? '';
    if (!matchesMoneyWords(action.slug, description, toolkit)) continue;
    if (classifyComposioAction(toolkit, action.slug, tags) === 'read') continue;
    rows.push({ slug: action.slug, tags, description });
  }
  if (rows.length) {
    toolkits[toolkit] = rows.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  }
}

const fixture = JSON.stringify(
  {
    source:
      'Composio action catalog, `composio tools list <app>`; scripts/composio-money-word-candidates.mjs',
    checkedAt: values['checked-at'] ?? new Date().toLocaleDateString('en-CA'),
    matcher: 'tight',
    toolkits,
  },
  null,
  2
);
// Written as the repo's formatter would leave it, so a refresh diffs only real changes.
const prettierOptions = (await resolveConfig(outFile)) ?? {};
writeFileSync(outFile, await format(fixture, { ...prettierOptions, filepath: outFile }));
const rowCount = Object.values(toolkits).reduce((sum, rows) => sum + rows.length, 0);
console.log(
  `${Object.keys(catalog).length} apps, ${actions} actions: ${rowCount} non-read money-word matches in ${Object.keys(toolkits).length} apps; wrote ${outFile}`
);
