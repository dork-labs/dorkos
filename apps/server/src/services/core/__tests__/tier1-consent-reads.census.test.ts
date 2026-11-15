/**
 * DOR-4400: every Tier 1 sender reads consent through
 * `resolveTier1ChannelConsent`, which is off until a person has answered.
 *
 * Consent used to depend on a config migration having run: a file with every
 * channel on and `userHasDecided: false` was switched off only by an old
 * migration body. This census parses the server and the CLI and fails if any
 * code reads the install, heartbeat or usage flag through the env-only
 * `resolveTelemetryConsent`, which would let stored flags send on their own.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repo = fileURLToPath(new URL('../../../../../../', import.meta.url));
const ROOTS = ['apps/server/src', 'packages/cli/src'];
const TIER1_FLAG = /\.(install|heartbeat|usage)\b|['"](install|heartbeat|usage)['"]/;

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '__tests__' || entry.name === 'node_modules') return [];
    const name = path.join(dir, entry.name);
    if (entry.isDirectory()) return files(name);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [name] : [];
  });
}

/** Calls to `resolveTelemetryConsent` whose flag argument names a Tier 1 channel. */
function bypasses(text: string, name: string): string[] {
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === 'resolveTelemetryConsent' &&
      TIER1_FLAG.test(node.arguments[0]?.getText(source) ?? '')
    ) {
      found.push(node.getText(source));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('Tier 1 consent reads (DOR-4400)', () => {
  it('no sender reads install, heartbeat or usage around the person’s answer', () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of files(path.join(repo, root))) {
        const rel = path.relative(repo, file);
        for (const call of bypasses(readFileSync(file, 'utf8'), rel))
          offenders.push(`${rel}: ${call}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it.each([
    ['apps/server/src/index.ts', 'heartbeat'],
    ['apps/server/src/startup/steps/telemetry-extensions-runtimes.ts', 'install'],
    ['apps/server/src/startup/steps/telemetry-extensions-runtimes.ts', 'usage'],
  ])('%s gates %s through resolveTier1ChannelConsent', (file, channel) => {
    const text = readFileSync(path.join(repo, file), 'utf8');
    expect(text).toMatch(new RegExp(`resolveTier1ChannelConsent\\([\\s\\S]{0,120}?'${channel}'`));
  });

  it('catches a sender that goes back to the flag alone', () => {
    const mutant = 'resolveTelemetryConsent(telemetryConfig?.install ?? false, telemetryEnv);';
    expect(bypasses(mutant, 'mutant.ts')).toHaveLength(1);
    expect(
      bypasses('resolveTelemetryConsent(telemetryConfig?.errorReporting ?? false, env)', 'ok.ts')
    ).toEqual([]);
  });
});
