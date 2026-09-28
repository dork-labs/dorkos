/**
 * One way to read what an agent may do (spec `agent-permissions`, review D1).
 *
 * The permission gate's reader is the only place an arriving agent's
 * unscreened folder settings are narrowed, so anything that decides what an
 * agent may do (a tool call, a session's Files & commands stop, a scheduled
 * run, a room turn) must read an agent's `permissions` through it
 * (`permissionGateSources().readAgentPermissions`). A new direct read of the
 * manifest's `permissions`, or a new caller of the raw file reader, would
 * honour a folder's settings as written. This test fails on one, naming it.
 *
 * Each allowed site below says why it may read the file directly.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lex } from '../../../../../../../scripts/lib/code-only.mjs';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/** Files allowed to read an agent's stored `permissions` directly, and why. */
const ALLOWED: Record<string, string> = {
  'services/core/capabilities/permission-enforcement.ts':
    'defines the raw reader and the gate sources that wrap it',
  'services/core/permissions/index.ts':
    'wires the raw reader under the narrowing reader and hands the arrival screen what it narrows',
  'services/core/permissions/permission-upgrade-sweep.ts':
    'the boot fold reads the raw file to see retired fields the schema drops',
  'index.ts': 'the observer reads the raw file to compare it with what DorkOS last saw',
};

const PATTERNS = [
  /\.permissions\??\.(filesAndCommands|areas|actions)\b/,
  /\bmanifest\??\.permissions\b/,
  /\breadAgentPermissionsFromManifest\b/,
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('every read of what an agent may do goes through the gate reader', () => {
  it('finds no direct read outside the allowed sites', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join('/');
      if (ALLOWED[rel]) continue;
      const text = fs.readFileSync(file, 'utf-8');
      // Lexing every source file is what made this test slow enough to time
      // out on a busy CI runner. Blanking comments and strings only removes
      // text, so a file whose raw text matches no pattern cannot match as
      // code either: skip the lexer for it.
      if (!PATTERNS.some((p) => p.test(text))) continue;
      // Code only: comments and string text blanked, positions kept, so a
      // sentence that names a field is never mistaken for a read of it.
      const { code, parseErrors } = lex(text, file);
      if (parseErrors > 0) offenders.push(`${rel}: could not be read as code (${parseErrors})`);
      const original = text.split('\n');
      code.split('\n').forEach((line, i) => {
        if (PATTERNS.some((p) => p.test(line))) {
          offenders.push(`${rel}:${i + 1}: ${original[i]?.trim()}`);
        }
      });
    }
    expect(
      offenders,
      "Read an agent's permissions through permissionGateSources().readAgentPermissions, which narrows an unscreened arrival:\n" +
        offenders.join('\n')
    ).toEqual([]);
  });

  it('keeps its allowed list honest: every allowed file still exists', () => {
    for (const rel of Object.keys(ALLOWED))
      expect(fs.existsSync(path.join(SRC, rel)), rel).toBe(true);
  });
});
