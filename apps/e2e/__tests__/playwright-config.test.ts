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
 * `E2E_SITE` and `E2E_PROD` are set before the config module is imported so the
 * Marketing Site and production legs — both normally opt-in — are included: they
 * are two of the six legs the timeout invariant covers, and skipping them here
 * would leave their timeouts unchecked.
 *
 * @module __tests__/playwright-config
 */

/**
 * Load the config with every opt-in leg switched on.
 *
 * The flags are read at the config's MODULE scope and `import()` caches modules,
 * so whichever block runs first decides what all of them see — setting them in
 * one place is what keeps that from depending on describe order.
 *
 * @returns The `webServer` entries, as the config built them.
 */
async function allLegs(): Promise<{ timeout?: number; command: string }[]> {
  // Deliberate direct process.env access: this package has no env.ts (see
  // playwright.config.ts's own top-of-file disable), and this sets the flags
  // the config module itself reads, not a config read of our own.
  /* eslint-disable no-restricted-syntax */
  process.env.E2E_SITE = '1';
  process.env.E2E_PROD = '1';
  /* eslint-enable no-restricted-syntax */
  const { default: config } = await import('../playwright.config.js');
  const webServer = config.webServer;
  return Array.isArray(webServer) ? webServer : webServer ? [webServer] : [];
}

describe('playwright.config.ts webServer legs', () => {
  let timeouts: number[];
  let commands: string[];

  beforeAll(async () => {
    const legs = await allLegs();
    timeouts = legs.map((leg) => leg.timeout ?? 0);
    commands = legs.map((leg) => leg.command);
  });

  it('gives every leg a distinct readiness timeout', () => {
    // Six legs expected: Express API, Vite Client, Express API (test-mode),
    // Vite Client (test-mode), Marketing Site, Express API (production) — the
    // last two only present because their flags were set before the import.
    expect(timeouts.length).toBe(6);
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
    legs = dataDirectories((await allLegs()).map((leg) => leg.command));
  });

  it('finds the three Express legs, so the assertions below have something to check', () => {
    // Without this the whole group passes vacuously the day the `DORK_HOME=`
    // spelling changes — `flatMap` over no matches asserts nothing.
    expect(legs).toHaveLength(3);
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

/**
 * The production leg's two load-bearing words (DOR-1723).
 *
 * Same reason as every group above: neither would fail anything on its own.
 * Drop `NODE_ENV=production` and the server never enters the branch that serves
 * the built shell — it answers `/api/health`, so the leg boots green, and every
 * spec in `tests/production/` then 404s or asserts against nothing. Drop the
 * client build and there is no `dist/` to serve at all. Both turn the only
 * coverage the shipped Content-Security-Policy has in a browser into a leg that
 * looks healthy and proves nothing.
 */
describe('the production leg serves the app the way it ships', () => {
  let command: string;

  beforeAll(async () => {
    const legs = await allLegs();
    const production = legs.filter((leg) => leg.command.includes('NODE_ENV=production'));
    // Exactly one, so a second production-mode leg (or a rename that loses this
    // one) is a failure rather than a silently narrowed assertion.
    expect(production).toHaveLength(1);
    command = production[0]!.command;
  });

  it('builds the client it is going to serve', () => {
    expect(command).toContain('--filter=@dorkos/client');
  });

  it('stands alone, with no Vite dev server in front of it', () => {
    // `VITE_PORT` is how the other legs tell the server which cross-origin dev
    // client to trust. In production the server IS the client's origin
    // (`getStaticLocalOrigins`), so naming one here would either be inert or a
    // sign this leg had quietly grown a proxy — and a proxied shell is the shell
    // with no policy on it, which is the exact blindness this leg removes.
    expect(command).not.toContain('VITE_PORT=');
  });
});
