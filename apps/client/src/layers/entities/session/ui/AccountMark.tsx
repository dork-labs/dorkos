import { cn } from '@/layers/shared/lib';
import { useClaudeAccounts } from '@/layers/shared/model';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/layers/shared/ui';

interface AccountMarkProps {
  /**
   * The session's Claude account — the config directory its transcript lives
   * under. Absent for runtimes with no account concept, and for history from
   * before accounts existed; both render nothing.
   */
  account?: string;
  className?: string;
}

/**
 * Which Claude account a session belongs to, as a short name in the row.
 *
 * Text rather than an icon, unlike its `RuntimeMark`/`SessionOriginMark` neighbours:
 * the account IS the name, and no glyph can say "Acme Corp". The full path rides
 * the tooltip so the row stays readable while the exact directory is still one
 * hover away.
 *
 * **Renders only when more than one account is registered.** With one account
 * every row would wear the same badge, which tells the operator nothing they can
 * act on — and a default install has no accounts registered at all, so nothing
 * about it changes. Sessions the server did not attribute render nothing either.
 */
export function AccountMark({ account, className }: AccountMarkProps) {
  const { isMultiAccount, nameFor } = useClaudeAccounts();
  if (!account || !isMultiAccount) return null;

  const name = nameFor(account);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          aria-label={`Account: ${name}`}
          className={cn('text-3xs max-w-24 shrink-0 truncate', className)}
        >
          {name}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {account}
      </TooltipContent>
    </Tooltip>
  );
}
