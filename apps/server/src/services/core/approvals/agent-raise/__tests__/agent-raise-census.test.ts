/**
 * Security on DOR-4355 M4: a route joins agent-raise cards only with an effect
 * describer the server computes, and a write that re-checks the state it was
 * judged on. Every other front-door route keeps its 403 for agents.
 *
 * The effect is a required field, so the type system holds the first half. This
 * census holds the rest: the places that raise a card are exactly the reviewed
 * ones, so a new one can't join without a reviewer reading it and a test here.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SERVER_SRC = join(import.meta.dirname, '../../../../..');

/** Each reviewed caller, and the test that proves its card and its 409. */
const REVIEWED: Record<string, string> = {
  // The one shared door: a route opts in by passing `agentCard` to `runFrontDoorWrite`.
  'routes/front-door-step-up.ts': 'routes/__tests__/agent-raise-cards.test.ts',
  // DOR-4595: an agent adding an approver or DM id, or opening DMs, on a saved connection.
  'routes/relay-adapter-setting-routes.ts': 'routes/__tests__/agent-raise-cards.test.ts',
  // A chat-route raise (PATCH only); create and move stay 403 for agents.
  'routes/relay-binding-step-up.ts': 'routes/__tests__/agent-raise-cards.test.ts',
};

/** Every non-test source file under the server's `src`. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === '__tests__' || name === 'node_modules') return [];
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('agent-raise cards census', () => {
  it('raises a card only from the reviewed routes', () => {
    const callers = sources(SERVER_SRC)
      .filter((file) => !file.includes('/agent-raise/'))
      // A call to raise one, or an `agentCard` handed to a door (never a method call such as
      // the A2A gateway's `agentCard(id)`, a different thing).
      .filter((file) => /\braiseAgentCard\(|(?<!\.)\bagentCard\b/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SERVER_SRC, file))
      .sort();
    expect(callers).toEqual(Object.keys(REVIEWED).sort());
  });

  it('names a test for every reviewed route that exists', () => {
    for (const test of new Set(Object.values(REVIEWED))) {
      expect(statSync(join(SERVER_SRC, test)).isFile()).toBe(true);
    }
  });
});
