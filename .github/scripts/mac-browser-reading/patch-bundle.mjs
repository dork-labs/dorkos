/* global process, console */
/**
 * Add one scripted turn to the installed test runtime's scenario list. The tarball
 * has no scenario that navigates, and this reading needs an agent to navigate.
 * Refuses unless it can add exactly that one line, so nothing else in CI's build changes.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [, , bundle, scenario, record] = process.argv;
const source = readFileSync(bundle, 'utf8');
const anchor = /^( *)"local-browser-driving": localBrowserDrivingScenario,$/gm;
const found = source.match(anchor) ?? [];
if (found.length !== 1) throw new Error(`Expected one scenario anchor, found ${found.length}`);
const added = `"mac-reading": async function* (c, x, o) { yield* (await import(${JSON.stringify(`file://${scenario}`)})).run(c, x, o, { browser: currentBrowser(), composeRegistry, createLocalBrowserDomain }); },`;
writeFileSync(
  bundle,
  source.replace(anchor, (line, indent) => `${line}\n${indent}${added}`)
);
// A run must say it wasn't the untouched build.
writeFileSync(
  record,
  JSON.stringify({ patched: true, linesAdded: 1, scenario: 'mac-reading', line: added })
);
console.log(`Added one line to ${bundle}`);
