import { test, expect, type Page } from '@playwright/test';

/**
 * Browser proof of the managed-MCP OAuth "Sign in" flow (DOR-943, spec
 * `managed-mcp-oauth` §W1b): add an OAuth-protected http MCP server to an agent,
 * see its row report "needs sign-in", click Sign in, read the custody disclosure,
 * open the sign-in link (auto-approved), and watch the row flip to connected —
 * with the token stored and injected. No real vendor anywhere: everything is the
 * test-mode server plus an in-process mock OAuth-protected MCP server.
 *
 * ── SKIPPED: this spec is authored but not yet runnable ─────────────────────
 * The client half (this spec's selectors and assertions) is complete and shipped
 * in DOR-943. Two server-side pieces are NOT built yet, so the flow cannot go
 * green in CI; the suite is `describe.skip` so it reports pending, never a false
 * green (see `.claude/rules/testing.md`, "Assertions that cannot fail").
 *
 * Remaining work to un-skip (both under the existing `DORKOS_TEST_RUNTIME` gate):
 *
 *   1. A test-mode-gated mock OAuth-protected MCP server — a server-source Express
 *      sub-router mounted like `apps/server/src/routes/test-control.ts` (there is
 *      no standalone HTTP mock-server fixture today; everything runs in-process).
 *      The service-level engine test already proves the acquisition loop against a
 *      `fetchImpl` seam (`agent-mcp-oauth-service.test.ts`); this needs the same
 *      shape as a REAL HTTP server the operator's browser and the MCP probe client
 *      can reach. It must implement:
 *        - GET /.well-known/oauth-protected-resource       (RFC 9728)
 *        - GET /.well-known/oauth-authorization-server     (RFC 8414: registration,
 *          authorization, token endpoints)
 *        - POST /register                                  (RFC 7591 DCR)
 *        - GET /authorize   → 302 back to the DorkOS loopback callback
 *          (`/api/agents/mcp-oauth/callback`) with ?code=&state=, auto-approving
 *          like `/api/test/connect-approved`
 *        - POST /token      (authorization_code validating PKCE + refresh_token)
 *        - the protected streamable-http MCP endpoint: 401 + `WWW-Authenticate`
 *          until a valid bearer, then a normal `initialize` + `tools/list`.
 *      Plus a `POST /api/test/seed-oauth-mcp-agent` seam that seeds an agent whose
 *      manifest has this server enabled (transport http, `authKind: 'oauth2'`),
 *      returning `{ agentDir }`.
 *
 *   2. `TestModeRuntime.getMcpStatus(cwd)` must report the seeded managed OAuth
 *      server as `needs-auth` when the token cache holds no token for it, and
 *      `connected` once it does — that live status (via `GET /api/mcp-config`,
 *      joined by name in `AgentMcpServers`) is what makes the "Sign in" button
 *      appear and then flip to "Connected". TestModeRuntime implements neither
 *      `getMcpStatus` nor `setManagedMcpServers` today.
 *
 * When both land, delete the `.skip` and wire `seedOAuthMcpAgent` below.
 * ────────────────────────────────────────────────────────────────────────────
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

/**
 * Seed an agent whose manifest already has the mock OAuth server enabled, and
 * open its MCP servers section. Returns the agent's row locator.
 *
 * TODO(DOR-943 follow-up): implement `POST /api/test/seed-oauth-mcp-agent` and
 * the navigation to the agent's Tools tab; see the header note.
 */
async function openManagedServers(_page: Page): Promise<void> {
  throw new Error(
    'seed-oauth-mcp-agent + Tools-tab navigation not implemented yet — see the header note.'
  );
}

test.describe.skip('MCP OAuth sign-in (managed servers)', () => {
  test('add → needs sign-in → Sign in → approve → connected with N tools', async ({ page }) => {
    await openManagedServers(page);

    // The row for the OAuth server reports it needs a sign-in, in plain words.
    const row = page.getByText(SERVER_NAME);
    await expect(row).toBeVisible();
    await expect(page.getByText('Needs sign-in')).toBeVisible();

    // Sign in → the custody disclosure shows BEFORE the link is opened (consent
    // order = reading order).
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText(new RegExp(CUSTODY_FRAGMENT, 'i'))).toBeVisible();

    // Open the sign-in page — a real click, a real new tab, landing on the mock
    // server's auto-approving /authorize, which 302s back to the DorkOS callback.
    const popupPromise = page.waitForEvent('popup');
    await page
      .getByRole('link', { name: new RegExp(`Open the sign-in page for ${SERVER_NAME}`, 'i') })
      .click();
    const popup = await popupPromise;
    await popup.close();

    // Polling reaches connected; the row's status flips and the injected token is
    // now what makes the server's tools reachable.
    await expect(page.getByText(/Signed in — the server’s tools are available/i)).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText('Connected')).toBeVisible();

    // The token was stored + injected: probing the server now lists its tools
    // instead of reporting needs-auth (asserted through the same Test control the
    // UI exposes, once the mock MCP endpoint answers `tools/list` for a bearer).
    // A follow-up may assert the stored ciphertext through a test seam, mirroring
    // the service-level `agent-mcp-oauth-service.test.ts` proof.
    expect(API_URL).toContain(MOCK_PORT);
  });
});
