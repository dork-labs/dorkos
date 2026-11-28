/**
 * The callers T6 moved onto the turn port (spec `turns-survive-restarts` §10
 * child C, DOR-5214) start their turns through `services/runs` and nothing
 * else: no direct call of the launch path, the dispatcher, or the launch cap
 * they used to be refused by. A source check, because a caller that reaches
 * the launch path again would work, silently, with no run behind its wait.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** Each moved caller, and how it starts a turn: the port's hand-over, handed in at startup. */
const CALLERS: Record<string, string> = {
  'services/core/session-relay/relay-request-server.ts': 'this.deps.handOverTurn(',
  'services/core/session-relay/live-deps.ts': 'wiring()?.handOverTurn(',
  'services/runtimes/claude-code/mcp-tools/session-tools.ts': 'startSpinOffTurn,',
  'services/session/chat-messages/startup/spin-off-startup.ts': 'await handOver(input',
};

/** What starting a turn any other way looks like. */
const BYPASSES = [
  /\bdispatchSessionMessage\b/u,
  /\bdispatchMessage\b/u,
  /message-dispatcher/u,
  /\bisAgentLaunchCapFull\b/u,
  /\bLAUNCH_CAP_FULL\b/u,
  /\bRELAY_TOO_MANY_NEW_CHATS\b/u,
];

describe('the callers T6 moved start turns only through services/runs', () => {
  it.each(Object.entries(CALLERS))('%s', (file, door) => {
    const source = readFileSync(path.join(SRC, file), 'utf8');
    expect(source).toContain(door);
    for (const bypass of BYPASSES) expect(source).not.toMatch(bypass);
  });
});
