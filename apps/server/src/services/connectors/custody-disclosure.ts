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

/** Context a disclosure needs to name the service it is about. */
export interface CustodyDisclosureContext {
  /**
   * Human-facing service (or remote server) name, e.g. `'Gmail'` or `'Notion'`.
   * Interpolated into the managed and external copy; ignored by self-host,
   * whose promise is about the user's own infrastructure, not any one service.
   */
  service: string;
}

/**
 * Return the plain-language custody disclosure for one custody class, ready to
 * show before connect and on each account row.
 *
 * Throws on an unknown custody class rather than returning a blank — a missing
 * disclosure is a loud failure, never a silently unlabeled connection (spec §4,
 * §Security Considerations: the disclosure is a security control, not just copy).
 *
 * @param custody - The provider's custody stance.
 * @param ctx - Service naming context; see {@link CustodyDisclosureContext}.
 */
export function custodyDisclosure(
  custody: ConnectorCustody,
  ctx: CustodyDisclosureContext
): string {
  switch (custody) {
    case 'managed':
      // Managed (Composio) — tokens leave the machine. The middle sentence is
      // the canonical ADR string, reused verbatim.
      return (
        `Connecting ${ctx.service} takes you to that service to sign in. ` +
        `${MANAGED_CUSTODY_CANONICAL_SENTENCE} ` +
        'Your agents can then act for you; your password is never shared, and you can disconnect anytime.'
      );
    case 'self-host':
      // Self-host (Nango) — tokens stay in the operator's own infrastructure.
      return (
        "You're connecting through your own Nango server. The keys to this connection are " +
        'stored in your database, on infrastructure you control. Nothing about this connection ' +
        'leaves your systems.'
      );
    case 'external':
      // External (raw MCP) — the remote server holds its own credentials.
      return (
        `This tool connects straight to ${ctx.service}. DorkOS doesn't store or see its keys, ` +
        'that server manages its own sign-in.'
      );
    default:
      // Exhaustiveness guard: a new ConnectorCustody member must add its copy
      // here rather than fall through to a blank, undisclosed connection.
      return assertUnreachableCustody(custody);
  }
}

/**
 * The account-row shape a disclosure line is derived from — the subset of a
 * `ConnectedAccount` custody rendering needs.
 */
export interface DisclosableAccount {
  /** Custody stance echoed onto the account. */
  custody: ConnectorCustody;
  /** Service slug, used as the service name when no friendlier label exists. */
  toolkit: string;
  /** User-facing label, preferred as the service name in the disclosure. */
  label: string;
}

/**
 * Derive the disclosure line for one connected-account row. This is the
 * structural guarantee that every rendered account carries its own truthful
 * custody line: any surface listing accounts calls this, and it always returns
 * a non-empty line or throws.
 *
 * @param account - The account whose custody line is needed.
 */
export function disclosureForAccount(account: DisclosableAccount): string {
  return custodyDisclosure(account.custody, { service: account.label || account.toolkit });
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
