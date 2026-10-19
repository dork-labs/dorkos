/**
 * The bar a mini app's room WRITES run (DOR-3017): replying in a thread as the
 * person, and marking a thread read for them. Stricter than the extensions
 * person bar (`extensions-person-bar.ts`), because what it guards is the
 * person's own name on a message other people and agents act on.
 *
 * ## What must hold, in the order checked
 *
 * 1. **Nothing relayed.** A request the session relay carried
 *    (`ingress === 'relay'`) is refused whatever it presents.
 * 2. **No agent.** A caller that presents an agent identity, valid or not, or
 *    an approval token is refused. An agent posts as itself, through the
 *    room's own routes, never through a mini app.
 * 3. **A browser on DorkOS's own page.** The request must carry an `Origin`,
 *    and it must be one DorkOS serves itself (`resolveTrustedOrigins`, the
 *    static set, for the DNS-rebinding reason `extensions-person-bar.ts`
 *    gives). Browsers send `Origin` on every POST and PUT; a program calling
 *    from a shell, and a mini app's server half calling over HTTP, send none.
 *    Unlike the person bar, a missing `Origin` is a refusal, not a pass.
 * 4. **A window of the app.** The `X-Client-Id` every app window sends.
 * 5. **The person's own browser session, or nothing that is not one.** With a
 *    proved identity it must be a session cookie, never a per-user API key or
 *    an MCP token. With none, the gate must have been open for this request
 *    (this computer does not ask for a password) and it must carry no
 *    `Authorization` header.
 *
 * ## The residual, named
 *
 * A mini app's page code runs in the person's own window, so this bar cannot
 * tell the person's click from the page's own code, the same residual
 * `api.startWork` names: the reply is the person's, recorded in the audit
 * trail as made through that mini app.
 *
 * A server half running INSIDE DorkOS (the default runtime) is handed the
 * person's own headers by the extension proxy and can set any `Origin`, so it
 * passes too; it already has DorkOS's own access, so this is no new power. One
 * running in its own process is refused: the proxy strips its cookie and
 * client id, and its network guard blocks DorkOS's own port.
 *
 * And with the password off, a program on this computer that forges a trusted
 * `Origin` and an `X-Client-Id` reads as the app (DOR-505). Turning on "Ask
 * for a password on this computer too" closes that one.
 *
 * @module routes/extensions-rooms-bar
 */
import { APPROVAL_TOKEN_HEADER } from '../services/core/capabilities/index.js';
import { presentsAgentIdentity } from '../middleware/agent-identity.js';
import { credentialGated } from '../services/core/auth/gate-policy.js';
import { resolveTrustedOrigins } from '../lib/trusted-origins.js';
import type { RequestFacts } from '../http/request-facts.js';

/** Why the bar refused, for tests and the audit row. */
export type RoomWriteRefusal =
  'relayed' | 'agent' | 'no-origin' | 'other-site' | 'no-app-window' | 'not-a-browser-session';

/**
 * Run the bar.
 *
 * @param facts - The request's facts.
 * @returns `undefined` when the person, in their own window, is asking;
 *   otherwise why not.
 */
export function refuseRoomWrite(facts: RequestFacts): RoomWriteRefusal | undefined {
  if (facts.ingress === 'relay') return 'relayed';
  if (presentsAgentIdentity(facts)) return 'agent';
  if (facts.headers[APPROVAL_TOKEN_HEADER] !== undefined) return 'agent';

  const origin = facts.headers.origin;
  if (!origin) return 'no-origin';
  if (!resolveTrustedOrigins().includes(origin)) return 'other-site';

  const clientId = facts.headers['x-client-id'];
  if (typeof clientId !== 'string' || clientId.length === 0) return 'no-app-window';

  if (facts.user) {
    return facts.user.credential === 'cookie' ? undefined : 'not-a-browser-session';
  }
  if (credentialGated(facts)) return 'not-a-browser-session';
  return facts.headers.authorization === undefined ? undefined : 'not-a-browser-session';
}

/** What the person is told for each refusal. */
export const ROOM_WRITE_REFUSAL_MESSAGE: Record<RoomWriteRefusal, string> = {
  relayed: 'Nothing was posted. A mini app can only reply from your own window of DorkOS.',
  agent: 'Nothing was posted. Only the person can reply here, not an agent.',
  'no-origin': 'Nothing was posted. A mini app can only reply from your own window of DorkOS.',
  'other-site': 'Nothing was posted. This request came from a page that is not DorkOS.',
  'no-app-window': 'Nothing was posted. A mini app can only reply from your own window of DorkOS.',
  'not-a-browser-session':
    'Nothing was posted. Sign in to DorkOS in your browser to reply from a mini app.',
};
