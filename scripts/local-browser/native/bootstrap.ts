import { readFileSync } from 'node:fs';
export interface BootstrapBindings {
  fixtureHome: string;
  ownedChromeProfile: string;
  dataDirectory: string;
  attestation: string;
  guardLog: string;
}
/** Write this string to an owned .cjs, then load via system Node --require BEFORE installed bin. */
export function makeBootstrapSource(bindings: BootstrapBindings): string {
  // Read raw CJS text so a TypeScript loader cannot inject helpers into serialized functions.
  const raw = readFileSync(new URL('./discovery-guard.cjs', import.meta.url), 'utf8');
  const functionSource = raw.slice(raw.indexOf('function activate'), raw.lastIndexOf(';'));
  return '(' + functionSource + ')(' + JSON.stringify(bindings) + ');';
}
