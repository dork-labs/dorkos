import { AccountDot, STATUS_TONE_SURFACE } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { useSessionAccount, type SessionAccount } from '../model/use-session-account';

/** Props for {@link AccountBadgeView}. */
export interface AccountBadgeViewProps {
  /** The session's account, from `useSessionAccount`. */
  account: SessionAccount;
  /** Extra classes for the pill. */
  className?: string;
}

/**
 * The session header's account pill, drawn from an account already read: the
 * account's dot and name (`● Acct 2`), and on the error surface with `· out`
 * when the account ran out (`● Acct 4 · out`). A limit on one model only keeps
 * the normal pill, because the account still runs another model and the
 * status-bar chip carries that detail (spec `claude-account-ui` §6.3).
 *
 * Renders nothing unless the account identity gate is open and the account
 * can be named. The name is always printed, so color is never the only signal.
 */
export function AccountBadgeView({ account, className }: AccountBadgeViewProps) {
  if (!account.visible || !account.name) return null;
  const out = account.chipState === 'out';
  return (
    <span
      data-slot="account-badge"
      data-state={out ? 'out' : 'ok'}
      className={cn(
        'text-2xs inline-flex max-w-[10rem] min-w-0 shrink items-center gap-1 rounded-full border px-2 py-0.5',
        out ? cn(STATUS_TONE_SURFACE.error, 'border-status-error-border') : 'text-muted-foreground',
        className
      )}
    >
      {/* The name is printed beside it, so the dot's own name would be said twice. */}
      {account.color && (
        <span aria-hidden className="inline-flex">
          <AccountDot color={account.color} name={account.name} />
        </span>
      )}
      <span className="min-w-0 truncate" title={account.name}>
        {account.name}
      </span>
      {/* The space reads "Acct 4 · out" aloud and in a copy; flex layout ignores it. */}
      {out && ' '}
      {out && <span className="shrink-0 whitespace-nowrap">· out</span>}
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
