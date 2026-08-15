import type { APIRequestContext } from '@playwright/test';
import { test, expect } from '../../fixtures';
import { SERVER_ROUND_TRIP_MS } from '../../fixtures/rooms-api';

/**
 * An agent can react to what somebody said (capability A-06, RP7 —
 * ADR `260814-195522`, which reverses etiquette E16b's sending half).
 *
 * A reaction is the cheapest thing an agent can do in a room: it takes no turn,
 * writes no entry, sends no notice, and costs a token from a small hourly
 * budget. That is the whole design — "I saw this" without a paragraph about it.
 * `reactions.test.ts` and `rooms-reactions.test.ts` pin the budget, the toggle
 * and the route below the browser. What only a browser can add is the half that
 * has no unit test at all: that an agent's pill LANDS ON THE MESSAGE a reader is
 * looking at, and reads as that agent.
 *
 * ## Acting as an agent, honestly
 *
 * This spec was nearly written the dishonest way, so the trap is worth stating.
 * `POST /api/rooms/:id/entries/:entryId/reactions` takes the reacting identity
 * from the `X-DorkOS-Agent` header — and `resolveAgentIdentityFromHeaders`
 * **never rejects a request**. A made-up token does not 401; it falls through to
 * the operator, and the pill lands under the PERSON's author id. A test that
 * invented a token would therefore be green while proving the exact opposite of
 * its own name. (`team-room-api.ts` exploits that fall-through deliberately for
 * a different purpose, which is how it came up.)
 *
 * A real token is only ever issued into a spawned session's process env
 * (`agent-token-env.ts`), which a browser test has nothing to read. So the
 * test-mode leg grew one seam, `POST /api/test/agent-token`, that mints through
 * the production path and hands the token over. Everything after that is
 * shipped code: the header middleware, `resolveCaller`, the non-human branch of
 * `toggleReaction`, the `ReactionBudget`, the store, the room's live stream, and
 * the row the cockpit draws.
 *
 * ## What is NOT claimed here
 *
 * The cockpit draws an agent's reaction **identically** to a person's — no
 * `data-agent`, no different tint — and that is the design, not an omission: a
 * reaction is a reaction. So there is no "renders as an agent" assertion to
 * make. What distinguishes it, and what this asserts, is the accessible name:
 * the pill is announced as `<agent> reacted <emoji>`, resolved off the room
 * roster. An id the roster cannot place reads "Someone who left", so the name
 * being the agent's is a real claim about a real lookup.
 */

/**
 * Refuse to run anywhere but the test-mode leg.
 *
 * `/api/test/*` is mounted only under `DORKOS_TEST_RUNTIME`, and the mint seam
 * this spec depends on exists nowhere else — so a 404 is "wrong leg", not
 * "broken product".
 *
 * @param request - The test's API context.
 * @param agentPath - The agent to mint an identity for.
 * @param displayName - Its display name, for attribution labels.
 */
async function agentToken(
  request: APIRequestContext,
  agentPath: string,
  displayName: string
): Promise<string> {
  const res = await request.post('/api/test/agent-token', {
    data: { agentPath, displayName },
  });
  if (res.ok()) {
    const { token } = (await res.json()) as { token: string };
    return token;
  }
  // Two different 404s reach here and they mean opposite things, so they are
  // told apart by whether the route answered at all: the seam's own refusal is
  // JSON with an `error`, and a leg that never mounted `/api/test/*` answers
  // Express's stock HTML.
  const body = await res.text();
  if (res.status() === 404 && !body.includes('"error"')) {
    throw new Error(
      'This spec is running against a leg with no TestModeRuntime, so there is no way ' +
        'to obtain a real agent identity. Run it in the `chromium-rooms-agents` project.'
    );
  }
  throw new Error(`Could not mint an agent identity for ${agentPath}: ${res.status()} ${body}`);
}

test.describe('An agent reacting to a message @smoke', () => {
  test('the pill lands on the message, as the agent and not as you', async ({
    page,
    basePage,
    request,
    roomsApi,
    roomsPage,
  }) => {
    const tag = roomsApi.runId;
    const name = `Reactor${tag}`;
    // Left SILENT, which is the fixture's default and the right one here: this
    // spec is about an agent reacting, and a reaction is precisely the thing
    // that does not need a turn. Nothing below asks a runtime for anything.
    const agent = await roomsApi.registerAgent(name, '🫡', '#a855f7');
    const room = await roomsApi.createChannel(`react-${tag}`, `React ${tag}`, [agent]);
    const seat = room.members.find((member) => member.author.displayName === name)!.author.id;

    const said = `ship it ${tag}`;
    await roomsApi.postEntries(room.id, [said]);
    const [entryId] = await roomsApi.entryIds(room.id);

    // A real token, minted the way a spawn gets one. See this file's header for
    // why a fabricated one would make the whole test vacuous.
    const token = await agentToken(request, agent.projectPath, name);
    const reacted = await request.post(
      `/api/rooms/${room.id}/entries/${entryId}/reactions`,
      // `on: true` rather than a bare toggle: a toggle is not idempotent, and a
      // request the harness happened to retry would undo itself.
      { data: { emoji: '🎯', on: true }, headers: { 'X-DorkOS-Agent': token } }
    );
    expect(
      reacted.status(),
      `reacting as ${name} answered ${reacted.status()}: ${await reacted.text()}`
    ).toBe(202);

    // **The server holds it under the AGENT's author id.** This is the assertion
    // the fall-through would have broken: a token that failed to resolve puts
    // the operator's id here instead, and every visual assertion below would
    // still have passed.
    const stored = await roomsApi.reactionsOn(room.id, entryId!);
    expect(
      stored.find((reaction) => reaction.emoji === '🎯')?.authorIds,
      'the reaction did not land under the agent — its identity fell through to the operator'
    ).toEqual([seat]);

    await page.goto(`/channels?id=${room.id}`);
    await basePage.waitForAppReady();

    const entry = roomsPage.entry(said);
    await expect(entry).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });

    // On the message, not merely on the page: the pill row is positional, so a
    // reaction rendered against the wrong entry is a different assertion result.
    const pill = roomsPage.reaction(entry, '🎯');
    await expect(pill).toBeVisible({ timeout: SERVER_ROUND_TRIP_MS });

    // Named as the agent. The label is built off the room roster
    // (`reactionSummary`), so an author the roster cannot place reads "Someone
    // who left" — this is a claim about the lookup, not about a string.
    await expect(pill).toHaveAttribute('aria-label', new RegExp(`^${name} reacted`));
    // And not as YOU. `data-mine` is stamped only on the reader's own pill, and
    // its absence is what says the room knows whose this is.
    await expect(pill).not.toHaveAttribute('data-mine', 'true');
  });
});
