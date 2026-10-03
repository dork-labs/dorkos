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
 * @param props.ollama - Whether this runtime can run a model on this computer
 *   with Ollama (OpenCode). Only then is Ollama named.
 * @param props.className - Extra classes for the line.
 */
export function KeepItLocalNote({
  ollama = false,
  className,
}: {
  ollama?: boolean;
  className?: string;
}) {
  return (
    <p className={cn('text-muted-foreground text-xs', className)} data-testid="keep-it-local-note">
      Prefer to keep everything on this computer? Use your own sign-in{ollama ? ', or Ollama' : ''}.
    </p>
  );
}
