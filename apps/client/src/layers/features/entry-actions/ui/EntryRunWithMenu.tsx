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
 * **It lives here because there is one action surface.** It used to be a
 * session-only control hung directly in the row's toolbar slot while rooms had
 * a whole roving, right-clickable, long-pressable capsule beside it — two hover
 * systems for one idea. This is the capsule's `run-with` slot, offered when
 * `capabilities.runWith` says the conversation has it.
 *
 * @module features/entry-actions/ui/EntryRunWithMenu
 */
import { useState, type KeyboardEvent, type Ref } from 'react';
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

/** What "run this again, elsewhere" needs to know. */
export interface EntryRunWith {
  /** The prompt text to re-run — seeded into the fresh session's composer. */
  prompt: string;
  /** The current session id — resolves the same cwd and the runtime to exclude. */
  sessionId: string;
}

interface EntryRunWithMenuProps extends EntryRunWith {
  /** Registers the trigger with the toolbar's roving sequence. */
  triggerRef?: Ref<HTMLButtonElement>;
  /** The toolbar's own arrow-key handling, so the trigger stays in the sequence. */
  onTriggerKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
}

/** Setup-dialog state: closed, or open scoped to one runtime's Connect flow. */
type SetupDialogState = { open: boolean; runtime?: string };

/**
 * The capsule's `run-with` button, and the menu it opens.
 *
 * **It is a tab stop, and it is the one button in the capsule that is.** Every
 * other action is `tabIndex={-1}` and reached from the message with an arrow
 * key, which is what keeps a room one Tab per message
 * (`room-entry-actions.spec.ts`). This one keeps the tab order it has always
 * had, because the conversation that offers it — a session transcript — has no
 * other action in the capsule and no arrow-key path into one: making it rove
 * would take Run with away from the keyboard entirely. The rule is about the
 * ACTION, not about which surface is drawing it; it still registers with the
 * roving sequence, so a conversation that one day offers run-with alongside
 * reply and copy walks it with arrows like everything else.
 */
export function EntryRunWithMenu({
  prompt,
  sessionId,
  triggerRef,
  onTriggerKeyDown,
}: EntryRunWithMenuProps) {
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

  // Fresh session, always: an explicit new id bypasses the loader's
  // auto-select of an existing session; `runtime` binds it; `prompt` seeds it.
  const launchOn = (type: string) => {
    void navigate({
      to: '/session',
      search: { session: crypto.randomUUID(), dir: cwd, runtime: type, prompt },
    });
  };

  const runWith = (type: string) => {
    if (!isReady(type)) {
      // Not connected → Connect first (never launch into a runtime that would
      // only fail at the first message). The connect success continues the
      // launch via the dialog's onRuntimeReady.
      setSetupDialog({ open: true, runtime: type });
      return;
    }
    launchOn(type);
  };

  return (
    <>
      <ResponsiveDropdownMenu>
        <ResponsiveDropdownMenuTrigger asChild>
          <button
            ref={triggerRef}
            type="button"
            data-entry-action="run-with"
            aria-label="Run this prompt with another runtime"
            onKeyDown={onTriggerKeyDown}
            className="text-muted-foreground/60 hover:text-foreground hover:bg-muted inline-flex size-6 items-center justify-center rounded transition-colors duration-150"
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
        onRuntimeReady={(type) => {
          // Connect succeeded → resume the launch it interrupted.
          setSetupDialog({ open: false });
          launchOn(type);
        }}
      />
    </>
  );
}
