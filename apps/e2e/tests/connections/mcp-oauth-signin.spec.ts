import { test, expect, type APIRequestContext } from '@playwright/test';
import { McpOAuthSigninPage } from '../../pages/McpOAuthSigninPage.js';

/**
 * Browser proof of the managed-MCP OAuth "Sign in" flow (DOR-943 client half,
 * DOR-952 e2e; spec `managed-mcp-oauth` §W1b): add an OAuth-protected http MCP
 * server to an agent, see its row report "needs sign-in", click Sign in, read the
 * custody disclosure, open the sign-in link (auto-approved through the loopback
 * callback), and watch the row flip to connected — with the token stored and
 * injected. No real vendor anywhere: everything is the test-mode server plus an
 * in-process mock OAuth-protected MCP server (`routes/mock-mcp-oauth-server.ts`).
 *
 * The two server pieces this exercises (both under the `DORKOS_TEST_RUNTIME` gate):
 *   1. the mock OAuth-protected MCP server — RFC 9728/8414 discovery, RFC 7591
 *      DCR, the PKCE authorization-code grant, and a bearer-gated
 *      streamable-HTTP MCP endpoint that answers `tools/list` only for a token it
 *      issued. NOT the refresh grant: this spec finishes in seconds and the
 *      access token lives an hour, so refresh never fires here. It is covered by
 *      `routes/__tests__/mock-mcp-oauth-server.test.ts` instead; and
 *   2. `TestModeRuntime.getMcpStatus` — synthesizes `needs-auth`/`connected` from
 *      the managed-server injection resolver (bearer injected ⟺ connected), which
 *      `GET /api/mcp-config` serves and `AgentMcpServers` joins by name.
 *
 * The `POST /api/test/probe-mcp-oauth-server` seam dials the server through its
 * INJECTED connection, which is what makes the mock's bearer gate load-bearing:
 * before sign-in the injected connection carries no bearer (401 → needs-auth);
 * after sign-in the injected bearer unlocks `tools/list`, proving the token was
 * stored and injected.
 */

// eslint-disable-next-line no-restricted-syntax -- E2E test config; no env.ts available
const MOCK_PORT = process.env.DORKOS_MOCK_PORT || '4243';
const API_URL = `http://localhost:${MOCK_PORT}`;

/** The mock server's name, as it appears in the agent's managed-server list. */
const SERVER_NAME = 'granola';

/**
 * A stable fragment of the managed-MCP custody disclosure
 * (`mcpOAuthCustodyDisclosure` in `agent-mcp-oauth-service.ts`) — the copy the
 * consent surface must show BEFORE the sign-in link is opened.
 */
const CUSTODY_FRAGMENT = 'keeps the resulting token encrypted on this computer';

/** A managed-server probe result from `POST /api/test/probe-mcp-oauth-server`. */
interface ProbeResult {
  ok: boolean;
  toolCount?: number;
  needsAuth?: boolean;
  error?: string;
}

/** Probe a managed server through its injected connection (the loopback seam). */
async function probe(
  request: APIRequestContext,
  agentPath: string,
  name: string
): Promise<ProbeResult> {
  const res = await request.post(`${API_URL}/api/test/probe-mcp-oauth-server`, {
    data: { agentPath, name },
  });
  expect(res.ok()).toBe(true);
  return (await res.json()) as ProbeResult;
}

test('add → needs sign-in → Sign in → approve → connected with N tools', async ({
  page,
  request,
}) => {
  // Seed an agent whose manifest already has the mock OAuth server enabled.
  const seed = await request.post(`${API_URL}/api/test/seed-oauth-mcp-agent`);
  expect(seed.ok()).toBe(true);
  const { agentDir } = (await seed.json()) as { agentDir: string };

  const mcp = new McpOAuthSigninPage(page);
  await mcp.open(agentDir);

  // The card for the OAuth server reports it needs a sign-in, in plain words.
  await expect(mcp.row(SERVER_NAME)).toBeVisible();
  // Scoped to the card, not the whole section: a status that belonged to some
  // other server would otherwise satisfy this.
  await expect(mcp.row(SERVER_NAME).getByText('Needs sign-in')).toBeVisible();

  // The mock's bearer gate is real: probed through its injected connection with
  // no token yet, it answers 401 → needs-auth (reverting the gate would list
  // tools here instead, reddening this).
  const before = await probe(request, agentDir, SERVER_NAME);
  expect(before, JSON.stringify(before)).toMatchObject({ ok: false, needsAuth: true });

  // Sign in → the custody disclosure shows BEFORE the link is opened (consent
  // order = reading order).
  await mcp.signInButton(SERVER_NAME).click();
  await expect(mcp.mcpSection.getByText(new RegExp(CUSTODY_FRAGMENT, 'i'))).toBeVisible();

  // Open the sign-in page — a real click, a real new tab, landing on the mock
  // server's auto-approving /authorize, which 302s back to the DorkOS loopback
  // callback where the code→token exchange completes server-side.
  const popupPromise = page.waitForEvent('popup');
  await mcp.openSignInLink(SERVER_NAME).click();
  const popup = await popupPromise;
  await popup.waitForLoadState('domcontentloaded');
  // The callback page rendered its SUCCESS copy → the exchange finished and the
  // token is stored. Anchored on the headline, which names the server, rather
  // than on the "Back to DorkOS" link, which the failure page also carries: the
  // link alone would go green on a failed exchange. (The old assertion looked for
  // "return to DorkOS", copy that stopped existing in DOR-1004 — it was failing
  // on `main` before this change too.)
  await expect(popup.getByText(new RegExp(`signed in to ${SERVER_NAME}`, 'i'))).toBeVisible();
  await popup.close();

  // Polling reaches connected; the card's status flips and the panel confirms it.
  // The panel names the payoff: the poll came back connected AND reported how
  // many tools the mock exposes. (This asserted "available on the next turn"
  // before — the count-less fallback, which stopped being what this flow says
  // once DOR-1004 put `toolCount` on the poll result. It was failing on `main`
  // too.)
  await expect(mcp.mcpSection.getByText(/Connected · 2 tools\./)).toBeVisible({
    timeout: 15_000,
  });
  // "Signed in", not "Connected": DorkOS now holds a token, but nothing has
  // contacted the server since, and the chip says only what is known (DOR-985).
  // Row-scoped, and `exact` because the success panel's own copy starts with the
  // same two words.
  await expect(mcp.row(SERVER_NAME).getByText('Signed in', { exact: true })).toBeVisible();

  // Dismissing the panel hands the card back to the runtime's own status, which by
  // now reports a real connection — the bearer is being injected, so test-mode's
  // getMcpStatus reads `connected`.
  await mcp.dismissSignInPanel().click();
  await expect(mcp.row(SERVER_NAME).getByText('Connected')).toBeVisible({ timeout: 15_000 });

  // The token was stored AND injected: probing through the injected connection
  // now carries the bearer, so the mock lists its two tools.
  const after = await probe(request, agentDir, SERVER_NAME);
  expect(after, JSON.stringify(after)).toMatchObject({ ok: true, toolCount: 2 });
});
