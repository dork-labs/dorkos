import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Guards the invariants `playwright.config.ts` cannot state in code — distinct
 * readiness timeouts (DOR-1243), a client served with no hot module replacement
 * (DOR-1412), and a data directory no run may leak out of (DOR-1223, DOR-1551).
 *
 * The last two groups exist because those lines fail NOTHING if they are deleted.
 * A suite whose legs quietly stopped isolating themselves goes green while
 * copying somebody's history into `/tmp`, which is exactly how DOR-1551 lived
 * unnoticed through every browser-suite run for weeks.
 *
 * `E2E_SITE` is set before the config module is imported so the Marketing
 * Site leg — normally opt-in — is included: it is one of the five legs the
 * timeout invariant covers, and skipping it here would leave its timeout
 * unchecked.
 *
 * @module __tests__/playwright-config
 */
describe('playwright.config.ts webServer legs', () => {
  let timeouts: number[];
  let commands: string[];

  beforeAll(async () => {
    // Deliberate direct process.env access: this package has no env.ts (see
    // playwright.config.ts's own top-of-file disable), and this sets the flag
    // the config module itself reads, not a config read of our own.
    // eslint-disable-next-line no-restricted-syntax
    process.env.E2E_SITE = '1';
    const { default: config } = await import('../playwright.config.js');
    const webServer = config.webServer;
    const legs = Array.isArray(webServer) ? webServer : webServer ? [webServer] : [];
    timeouts = legs.map((leg) => leg.timeout ?? 0);
    commands = legs.map((leg) => leg.command);
  });

  it('gives every leg a distinct readiness timeout', () => {
    // Five legs expected: Express API, Vite Client, Express API (test-mode),
    // Vite Client (test-mode), Marketing Site — the last only present
    // because E2E_SITE was set above before the config was imported.
    expect(timeouts.length).toBe(5);
    expect(new Set(timeouts).size).toBe(timeouts.length);
  });

  it('serves the client with hot module replacement off', () => {
    // DOR-1412. Dropping the flag from either leg fails nothing on its own: the
    // suite goes green while a `turbo run build` anywhere in the checkout
    // hot-replaces a React context module under a live page, the app is
    // replaced by its error boundary, and the spec reports "expected 1,
    // received 0" about a feature nobody broke. Measured before the flag, one
    // spec run 40 times under a loop rewriting `packages/shared/dist`: 8 of 40
    // red, 7 of them showing that boundary. After: 0 of 40.
    //
    // Keyed off `turbo dev --filter=@dorkos/client` rather than off a leg's
    // `name`, so a third client leg added later is covered on the day it lands
    // rather than on the day somebody remembers this file.
    const clientLegs = commands.filter((command) =>
      command.includes('turbo dev --filter=@dorkos/client')
    );
    // Without this the assertion below passes vacuously the day the leg's
    // command is spelled another way — `every` over an empty list is true.
    expect(clientLegs).toHaveLength(2);
    for (const command of clientLegs) expect(command).toContain('DORKOS_E2E_NO_HMR=true');
  });
});

/**
 * Every leg that keeps a data directory, and where it keeps it.
 *
 * Keyed off `DORK_HOME=` rather than off a leg's `name`, so a third API leg
 * added later is covered on the day it lands rather than on the day somebody
 * remembers this file.
 *
 * @param commands - The `webServer` commands, as the config built them.
 */
function dataDirectories(commands: string[]): { command: string; dorkHome: string }[] {
  return commands.flatMap((command) => {
    const match = /DORK_HOME=(\S+)/.exec(command);
    return match ? [{ command, dorkHome: match[1]! }] : [];
  });
}

describe('every leg that stores data isolates it', () => {
  let legs: { command: string; dorkHome: string }[];

  beforeAll(async () => {
    // eslint-disable-next-line no-restricted-syntax -- see the note above
    process.env.E2E_SITE = '1';
    const { default: config } = await import('../playwright.config.js');
    const webServer = config.webServer;
    const all = Array.isArray(webServer) ? webServer : webServer ? [webServer] : [];
    legs = dataDirectories(all.map((leg) => leg.command));
  });

  it('finds the two Express legs, so the assertions below have something to check', () => {
    // Without this the whole group passes vacuously the day the `DORK_HOME=`
    // spelling changes — `flatMap` over no matches asserts nothing.
    expect(legs).toHaveLength(2);
    for (const leg of legs) expect(leg.dorkHome).toMatch(/^\/tmp\/dorkos-/);
  });

  it('creates each data directory empty and mode 0700 before the leg boots', () => {
    // `/tmp` is world-readable, and this directory holds the run's message-search
    // index, its `mcp-local-token` and its `better-auth-secret`. At the default
    // `umask 022` the server created it 0755 (DOR-1551).
    for (const leg of legs) {
      expect(leg.command).toContain(`rm -rf ${leg.dorkHome}`);
      expect(leg.command).toContain(`mkdir -m 700 -p ${leg.dorkHome}`);
    }
  });

  it('tells each leg to index its own data directory and nothing else', () => {
    // `DORK_HOME` isolates what DorkOS owns; it does not move `~/.claude`,
    // `$CODEX_HOME` or OpenCode's store. Without this flag the message-search
    // sweep copied the operator's real transcripts into the throwaway directory
    // on every run of the suite (DOR-1551).
    for (const leg of legs) {
      expect(leg.command).toContain('DORKOS_SEARCH_NO_EXTERNAL_HISTORY=true');
    }
  });
});
