/**
 * Who started this chat, and what it was asked (spec `flow-multiproject` §7.7,
 * V7): the chat's first line when an extension or another chat started it.
 *
 * - {@link StartedByLine} — "Started by the Flow extension: 12 new ideas were
 *   waiting to be sorted", or "Started from <that chat>: <reason>" with the chat as a link.
 *   A session adornment, never a message, and never sent to the model. A chat
 *   started from another chat adds the level it was started at, which is never
 *   higher than its starter's (spec `inherited-start-permission`): "Started at
 *   Full autonomy, same as the chat that started it."
 * - {@link StartedPrompt} — the prompt it was started with, which is the chat's
 *   first message, folded to one line ("What it was asked ▸") so it is there to
 *   read but is never the headline. An extension's prompt is often a command
 *   written for the agent; the line above is the one written for the person.
 *
 * @module features/chat/ui/StartedByLine
 */
import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import type { PermissionModeDescriptor } from '@dorkos/shared/agent-runtime';
import type { SessionStartedBy } from '@dorkos/shared/types';
import {
  cn,
  isAutonomyStop,
  isBypassPermissionMode,
  permissionModeLabel,
  toSession,
} from '@/layers/shared/lib';
import { stopLabel } from '@/layers/shared/ui';

/** What the line says a chat it cannot name is called. */
const UNNAMED_CHAT = 'another chat';

/**
 * What to call the level a chat was started at: the dial's own words for Full
 * autonomy, which is the level a person recognises, and the runtime's own name
 * for every other mode. Before the runtime's modes load, the id's known name.
 */
function startedLevelLabel(
  mode: string,
  modes: readonly PermissionModeDescriptor[] | undefined
): string {
  const declared = modes?.find((m) => m.id === mode);
  if (declared) return isAutonomyStop(declared) ? stopLabel('autonomy') : declared.label;
  return isBypassPermissionMode(mode) ? stopLabel('autonomy') : permissionModeLabel(mode);
}

/**
 * The first line of a chat an extension or another chat started, or nothing.
 *
 * @param props.startedBy - Who started the chat, or null for a person's own chat.
 * @param props.modes - The modes this chat's runtime declares, to name its level.
 */
export function StartedByLine({
  startedBy,
  modes,
}: {
  startedBy: SessionStartedBy | null;
  modes?: readonly PermissionModeDescriptor[];
}) {
  const navigate = useNavigate();
  if (!startedBy) return null;

  const reason = startedBy.reason?.trim() || null;
  const permission = startedBy.kind === 'chat' ? startedBy.permission : null;
  return (
    <>
      <StartedByText startedBy={startedBy} reason={reason} navigate={navigate} />
      {permission && (
        <p
          data-testid="started-level-line"
          className="text-muted-foreground mx-auto max-w-prose px-4 pb-1 text-center text-xs"
        >
          {/* A record of the start, not the chat's mode now: that can change. */}
          Started at {startedLevelLabel(permission.mode, modes)},{' '}
          {permission.sameAsStarter ? 'same as' : 'lower than'} the chat that started it.
        </p>
      )}
    </>
  );
}

/** "Started by …" / "Started from …", with the starting chat as a link. */
function StartedByText({
  startedBy,
  reason,
  navigate,
}: {
  startedBy: SessionStartedBy;
  reason: string | null;
  navigate: ReturnType<typeof useNavigate>;
}) {
  return (
    <p
      data-testid="started-by-line"
      className="text-muted-foreground mx-auto max-w-prose px-4 pt-3 pb-1 text-center text-xs"
    >
      {startedBy.kind === 'extension' ? (
        <>
          {/* "the … extension" in words, so a manifest named "You" or "DorkOS"
            still reads as an extension and never as a person or the app. */}
          Started by the{' '}
          <span className="text-foreground font-medium">{startedBy.extensionName}</span> extension
        </>
      ) : (
        <>
          Started from{' '}
          <button
            type="button"
            onClick={() => void navigate(toSession({ session: startedBy.sessionId }))}
            className="text-foreground focus-visible:ring-ring rounded-sm font-medium underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:outline-none"
          >
            {startedBy.title ?? UNNAMED_CHAT}
          </button>
        </>
      )}
      {reason && <>: {reason}</>}
    </p>
  );
}

/**
 * The prompt a started chat was given, folded under one quiet line.
 *
 * @param props.content - The first message, exactly as it was sent.
 */
export function StartedPrompt({ content }: { content: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div data-testid="started-prompt" className="px-4 py-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring mx-auto flex items-center gap-1 rounded-sm text-xs focus-visible:ring-2 focus-visible:outline-none"
      >
        What it was asked
        <ChevronRight
          aria-hidden="true"
          className={cn('size-3 transition-transform duration-200', open && 'rotate-90')}
        />
      </button>
      {open && (
        <div className="bg-muted/40 text-foreground mx-auto mt-2 max-w-prose rounded-md px-3 py-2 text-sm break-words whitespace-pre-wrap">
          {content}
        </div>
      )}
    </div>
  );
}
