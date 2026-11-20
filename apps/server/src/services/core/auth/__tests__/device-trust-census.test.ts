/**
 * Only the person routes reach what approves a Wi-Fi device, lets one run
 * agents, signs a checked account in, or adds a sign-in check (DOR-4744,
 * DOR-3647). No MCP tool, capability, agent route or other module may call
 * them, so no agent, API key or approval token has a way in except those
 * routes and their person bars.
 *
 * Read from the source tree, tests excluded: a new caller anywhere else fails
 * here until it is named below with a reason.
 */
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '../../../..');

/** Every non-test TypeScript file under `apps/server/src`. */
function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [full] : [];
  });
}

/** Each guarded function, and the only files besides its own module that may call it. */
const GUARDED: Record<string, readonly string[]> = {
  approveWifiSignIn: ['routes/devices.ts'],
  setWifiAgentTurns: ['routes/devices.ts'],
  signInCheckedAccount: ['http/sign-in/wifi-sign-in.ts', 'http/sign-in/owner-passkey-sign-in.ts'],
  startAddingPasskey: ['routes/owner-factors.ts'],
  finishAddingPasskey: ['routes/owner-factors.ts'],
  addPendingTotp: ['routes/owner-factors.ts'],
  confirmTotp: ['routes/owner-factors.ts'],
  removeOwnerFactor: ['routes/owner-factors.ts'],
  addPasskey: ['services/core/auth/factors/owner-passkeys.ts'],
};

/** The module each is defined in. */
const HOME: Record<string, string> = {
  approveWifiSignIn: 'services/core/auth/sessions/wifi-sign-in-requests.ts',
  setWifiAgentTurns: 'services/core/auth/sessions/wifi-agent-turns.ts',
  signInCheckedAccount: 'services/core/auth/sessions/checked-sign-in.ts',
  startAddingPasskey: 'services/core/auth/factors/owner-passkeys.ts',
  finishAddingPasskey: 'services/core/auth/factors/owner-passkeys.ts',
  addPendingTotp: 'services/core/auth/factors/owner-factors.ts',
  confirmTotp: 'services/core/auth/factors/owner-factors.ts',
  removeOwnerFactor: 'services/core/auth/factors/owner-factors.ts',
  addPasskey: 'services/core/auth/factors/owner-factors.ts',
};

describe('device trust census', () => {
  const files = sourceFiles(SRC).map((file) => ({
    rel: path.relative(SRC, file).split(path.sep).join('/'),
    text: fs.readFileSync(file, 'utf8'),
  }));

  it.each(Object.keys(GUARDED))('%s is called only from its person route', (name) => {
    const callers = files
      .filter(({ rel, text }) => rel !== HOME[name] && new RegExp(`\\b${name}\\b`).test(text))
      .map(({ rel }) => rel);
    expect(callers.sort()).toEqual([...GUARDED[name]!].sort());
  });

  it('no MCP tool or capability names the Wi-Fi sign-in or a sign-in check', () => {
    const offenders = files
      .filter(({ rel }) => /(^|\/)(mcp|capabilities|mcp-tools|marketplace-mcp)\//.test(rel))
      .filter(({ text }) =>
        /sign-in-requests|runs-agents|owner-factors|wifi-sign-in|owner-sign-in/.test(text)
      )
      .map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });
});
