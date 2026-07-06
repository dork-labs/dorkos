/**
 * "Run this with…" — re-run a prompt into a FRESH session bound to another
 * runtime (spec effortless-runtime-switching, task 3.2; ADR-0255).
 *
 * A runtime switch is ALWAYS a new session, never a mutation of the current
 * one and never a transplant of its history. This menu reuses the existing
 * `?runtime=` launch and carries the prompt as the `?prompt=` seed: it mints a
 * fresh session id (so the route loader can never auto-select an existing
 * session), binds it to the chosen runtime, and lets the new session's composer
 * pick up the prompt. The current session — its binding and transcript — is
 * never touched.
 *
 * Only Ready runtimes launch directly; a not-yet-connected target opens its
 * Connect surface first, so a switch is never a dead end.
 *
 * @module features/chat/ui/message/RunWithMenu
 */
import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Shuffle } from 'lucide-react';
import { useSessions } from '@/layers/entities/session';
import {
  PRIMARY_RUNTIME_TYPES,
  RuntimeSetupDialog,
  getRuntimeDescriptor,
  isRuntimeReady,
  useRuntimeCapabilities,
  useRuntimeRequirements,
} from '@/layers/entities/runtime';
import { renderRuntimeConnect } from '@/layers/features/runtime-connect';
import {
  ResponsiveDropdownMenu,
  ResponsiveDropdownMenuTrigger,
  ResponsiveDropdownMenuContent,
  ResponsiveDropdownMenuItem,
  ResponsiveDropdownMenuLabel,
} from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';

interface RunWithMenuProps {
  /** The prompt text to re-run — seeded into the fresh session's composer. */
  prompt: string;
  /** The current session id — resolves the same cwd and the runtime to exclude. */
  sessionId: string;
  /** Extra classes for the trigger button (positioning / hover reveal). */
  className?: string;
}

/** Setup-dialog state: closed, or open scoped to one runtime's Connect flow. */
type SetupDialogState = { open: boolean; runtime?: string };

/**
 * Trigger + menu that re-runs `prompt` into a fresh session on another runtime.
 */
export function RunWithMenu({ prompt, sessionId, className }: RunWithMenuProps) {
  const navigate = useNavigate();
  const { sessions } = useSessions();
  const { data: capabilityMap } = useRuntimeCapabilities();
  const { data: requirements } = useRuntimeRequirements();
  const [setupDialog, setSetupDialog] = useState<SetupDialogState>({ open: false });

  const row = sessions.find((s) => s.id === sessionId);
  const currentRuntime = row?.runtime;
  const cwd = row?.cwd;

  // Offer the primary siblings other than the one this prompt already ran on —
  // "run this elsewhere". A runtime the server has not registered still appears
  // (its Connect flow can install/connect it first).
  const targets = PRIMARY_RUNTIME_TYPES.filter((type) => type !== currentRuntime);

  const isReady = (type: string) => {
    const registered = capabilityMap ? type in capabilityMap.capabilities : true;
    return registered && isRuntimeReady(requirements, type);
  };

  const runWith = (type: string) => {
    if (!isReady(type)) {
      // Not connected → Connect first (never launch into a runtime that would
      // only fail at the first message).
      setSetupDialog({ open: true, runtime: type });
      return;
    }
    // Fresh session, always: an explicit new id bypasses the loader's
    // auto-select of an existing session; `runtime` binds it; `prompt` seeds it.
    void navigate({
      to: '/session',
      search: { session: crypto.randomUUID(), dir: cwd, runtime: type, prompt },
    });
  };

  return (
    <>
      <ResponsiveDropdownMenu>
        <ResponsiveDropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Run this prompt with another runtime"
            className={cn(
              'text-muted-foreground/60 hover:text-foreground inline-flex items-center transition-colors duration-150',
              className
            )}
          >
            <Shuffle className="size-3.5" />
          </button>
        </ResponsiveDropdownMenuTrigger>
        <ResponsiveDropdownMenuContent align="end" className="w-52">
          <ResponsiveDropdownMenuLabel>Run this with…</ResponsiveDropdownMenuLabel>
          {targets.map((type) => {
            const descriptor = getRuntimeDescriptor(type);
            return (
              <ResponsiveDropdownMenuItem
                key={type}
                icon={descriptor.icon}
                description={isReady(type) ? undefined : 'Connect'}
                onSelect={() => runWith(type)}
              >
                {descriptor.label}
              </ResponsiveDropdownMenuItem>
            );
          })}
        </ResponsiveDropdownMenuContent>
      </ResponsiveDropdownMenu>
      <RuntimeSetupDialog
        runtime={setupDialog.runtime}
        open={setupDialog.open}
        onOpenChange={(open) => setSetupDialog((s) => ({ ...s, open }))}
        renderConnect={renderRuntimeConnect}
      />
    </>
  );
}
