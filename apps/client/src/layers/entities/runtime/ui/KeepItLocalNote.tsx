/**
 * The privacy line that sits beside every DorkOS credits offer.
 *
 * @module entities/runtime/ui/KeepItLocalNote
 */
import { cn } from '@/layers/shared/lib';

/**
 * Say, where DorkOS credits are offered first, that nothing has to leave this
 * computer: a person's own sign-in still works, and for a runtime that can run
 * a model locally, so does Ollama. One wording for every surface that offers
 * credits (spec `dorkos-account-by-default` §3), so it lives here rather than
 * in any one of them.
 *
 * Seen from somewhere else (a phone), "this computer" would be the wrong
 * one, so the line names the computer DorkOS runs on instead.
 *
 * @param props.ollama - Whether this runtime can run a model on this computer
 *   with Ollama (OpenCode). Only then is Ollama named.
 * @param props.remote - Whether this browser is not on the computer DorkOS
 *   runs on.
 * @param props.className - Extra classes for the line.
 */
export function KeepItLocalNote({
  ollama = false,
  remote = false,
  className,
}: {
  ollama?: boolean;
  remote?: boolean;
  className?: string;
}) {
  return (
    <p className={cn('text-muted-foreground text-xs', className)} data-testid="keep-it-local-note">
      {remote
        ? 'Prefer to keep everything on the computer DorkOS runs on? Use your own sign-in there'
        : 'Prefer to keep everything on this computer? Use your own sign-in'}
      {ollama ? ', or Ollama' : ''}.
    </p>
  );
}
