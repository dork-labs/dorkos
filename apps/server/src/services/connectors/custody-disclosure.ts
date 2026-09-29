/**
 * Custody disclosure — the plain-language sentence that states, before a user
 * connects and again per account, WHERE their login tokens live. Custody is
 * where "be honest by design" bites hardest (a connector moves the user's real
 * credentials somewhere), so this module is the single source of truth for that
 * copy: the connect picker and the per-account list both render from here, and
 * no account row or connect confirmation is allowed to render without a
 * disclosure line for its custody class.
 *
 * Copy follows the `writing-for-humans` bar (readable by a smart 9th grader who
 * doesn't code) and is taken from connector-gateway spec §Detailed Design 4.
 * The managed sentence is verbatim from accepted ADR `260718-045630`
 * (§Custody disclosure), which mandates that product copy reuse it exactly —
 * {@link MANAGED_CUSTODY_CANONICAL_SENTENCE} pins it so a future edit cannot
 * silently drop it (a copy-drift unit test asserts its bytes).
 *
 * @module services/connectors/custody-disclosure
 */
import type { ConnectorCustody } from '@dorkos/shared/connector-provider';

/**
 * The canonical managed-custody sentence, byte-verbatim from ADR `260718-045630`
 * §Custody disclosure. Any managed disclosure MUST contain this string exactly;
 * the managed copy is composed from it so the two can never diverge.
 */
export const MANAGED_CUSTODY_CANONICAL_SENTENCE =
  "Composio stores your connected accounts' login access in its own secure vault, not on your computer.";

/**
 * Return the plain-language custody disclosure for one custody class, ready to
 * show before connect and on each account row. The words never name the way
 * or the app: the surface already shows both beside it.
 *
 * Throws on an unknown custody class rather than returning a blank — a missing
 * disclosure is a loud failure, never a silently unlabeled connection (spec §4,
 * §Security Considerations: the disclosure is a security control, not just copy).
 *
 * @param custody - The provider's custody stance.
 */
export function custodyDisclosure(custody: ConnectorCustody): string {
  switch (custody) {
    case 'managed':
      // Managed (Composio): preserve the required custody fact without making
      // an OAuth-only password promise or implying newly connected agents gain access.
      return (
        `${MANAGED_CUSTODY_CANONICAL_SENTENCE} ` +
        'Choose which agents can use this account. You can disconnect anytime.'
      );
    case 'self-host':
      // Self-host (Nango): sign-ins stay in the operator's own database. It
      // never promises nothing leaves: actions still go out to the app itself.
      return (
        "You're connecting through your own Nango server. Its sign-ins are stored in your own " +
        'database, on computers you control, not with DorkOS.'
      );
    case 'external':
      // External (raw MCP): DorkOS may hold access details for the MCP
      // endpoint, while login credentials used behind it stay with that server.
      return (
        "This app's tools connect straight to its own server. DorkOS uses the connection details " +
        'you set up to check that server before adding it. Any sign-in its tools need stays with ' +
        'that server.'
      );
    default:
      // Exhaustiveness guard: a new ConnectorCustody member must add its copy
      // here rather than fall through to a blank, undisclosed connection.
      return assertUnreachableCustody(custody);
  }
}

/**
 * Fail loudly for a custody class with no copy. Typed to `never` so a new
 * {@link ConnectorCustody} member becomes a compile error at the call site.
 *
 * @param custody - The unhandled custody value.
 */
function assertUnreachableCustody(custody: never): never {
  throw new Error(`no custody disclosure for class: ${JSON.stringify(custody)}`);
}
