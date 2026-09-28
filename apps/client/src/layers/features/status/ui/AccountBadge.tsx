import { AccountDot, STATUS_TONE_SURFACE } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { sessionLimitDisplay } from '@/layers/entities/session';
import { useSessionAccount, type SessionAccount } from '../model/use-session-account';

/** Props for {@link AccountBadgeView}. */
export interface AccountBadgeViewProps {
  /** The session's account, from `useSessionAccount`. */
  account: SessionAccount;
  /** Extra classes for the pill. */
  className?: string;
}

/**
 * The words a narrow header shows for the chosen wait: "out · waiting for
 * reset" does not fit a phone's bar beside the name, so there it reads "out ·
 * waiting" while the accessible name and the tooltip keep the full words
 * (orchestrator, 04 §15). Every other state's words fit and never shorten.
 */
const NARROW_WAITING_TEXT = 'out · waiting';

/**
 * The session header's account pill, drawn from an account already read: the
 * account's dot and name (`● Acct 2`), and, when the session ran out, the
 * sidebar row's own words (`● Acct 4 · out · needs you`).
 *
 * It follows the sidebar row's rule exactly (`sessionLimitDisplay`, spec
 * `claude-account-ui` §6.2 and §6.3), so the two never disagree: red with
 * "out · needs you" or "out · handing off" while the session needs action,
 * neutral with "out · waiting for reset" once the person chose to wait (Q13),
 * and plain for a moved session (Q14), a limit on one model only, or no limit
 * of its own. The words differ wherever the color does, so color is never the
 * only signal.
 *
 * Renders nothing unless the account identity gate is open and the account
 * can be named.
 */
export function AccountBadgeView({ account, className }: AccountBadgeViewProps) {
  if (!account.visible || !account.name) return null;
  const display = sessionLimitDisplay(account.limit);
  const tone = display ? (display.needsAction ? 'action' : 'waiting') : 'ok';
  const fullLabel = display ? `${account.name}, ${display.text}` : account.name;
  const narrowText = display && !display.needsAction ? NARROW_WAITING_TEXT : display?.text;
  return (
    <span
      role="group"
      aria-label={fullLabel}
      title={display ? `${account.name} · ${display.text}` : account.name}
      data-slot="account-badge"
      data-state={tone}
      className={cn(
        'text-2xs inline-flex max-w-[16rem] min-w-0 shrink items-center gap-1 rounded-full border px-2 py-0.5',
        display?.needsAction
          ? cn(STATUS_TONE_SURFACE.error, 'border-status-error-border')
          : 'text-muted-foreground',
        className
      )}
    >
      {/* The name is printed beside it, so the dot's own name would be said twice. */}
      {account.color && (
        <span aria-hidden className="inline-flex">
          <AccountDot color={account.color} name={account.name} tooltip={false} />
        </span>
      )}
      <span className="min-w-0 truncate">{account.name}</span>
      {/* The space reads "Acct 4 · out · needs you" in a copy; flex layout ignores it. */}
      {display && ' '}
      {display && (
        <>
          {/* Full words wherever the bar has room; the short form only on a
              narrow bar (the same container query the origin chip uses). */}
          <span className="shrink-0 whitespace-nowrap @max-md/bar:hidden">· {display.text}</span>
          <span
            data-slot="account-badge-narrow"
            aria-hidden
            className="hidden shrink-0 whitespace-nowrap @max-md/bar:inline"
          >
            · {narrowText}
          </span>
        </>
      )}
    </span>
  );
}

/** Props for {@link AccountBadge}. */
export interface AccountBadgeProps {
  /** The session the header shows, or `null` when there is none. */
  sessionId: string | null;
  /** Extra classes for the pill. */
  className?: string;
}

/**
 * Which account the open session spends, as a small outlined pill in the
 * session header (spec `claude-account-ui` §6.3). Reads `useSessionAccount`,
 * the one source the status-bar chip and the out-of-usage banner read too, so
 * they cannot disagree. See {@link AccountBadgeView} for what it draws.
 */
export function AccountBadge({ sessionId, className }: AccountBadgeProps) {
  const account = useSessionAccount(sessionId);
  return <AccountBadgeView account={account} className={className} />;
}
