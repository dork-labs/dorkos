import { Plug, Unplug } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Session } from '@dorkos/shared/types';
import { useSessionRow } from '@/layers/entities/session';
import { Notice } from '@/layers/shared/ui';

/** One notice: its icon and its lines. */
interface ToolsNotice {
  key: string;
  icon: LucideIcon;
  lines: string[];
}

/** The notices a chat's row asks for, in the order they show. */
function noticesOf(session: Session): ToolsNotice[] {
  const notices: ToolsNotice[] = (session.warnings ?? []).map((warning) => ({
    key: warning.code,
    icon: Unplug,
    lines: [warning.message, 'Choose an agent when starting a chat to use DorkOS tools.'],
  }));
  // Only the server sets this, from its own record of the tool list (DOR-4393).
  if (session.dorkosTools === 'lost') {
    notices.push({
      key: 'dorkos-tools',
      icon: Unplug,
      lines: [
        "This chat lost its DorkOS tools. It can still answer, but can't act in DorkOS.",
        'It tries again with your next message.',
      ],
    });
  } else if (session.dorkosTools === 'back') {
    // The same key, so "back" replaces "lost" in place.
    notices.push({
      key: 'dorkos-tools',
      icon: Plug,
      lines: ["This chat's DorkOS tools are back."],
    });
  }
  return notices;
}

/** Show the chat's tool notices from the server, including when it is reopened. */
export function SessionToolsNotice({ sessionId }: { sessionId: string | null }) {
  const { data: notices } = useSessionRow(sessionId, { select: noticesOf });
  if (!notices?.length) return null;
  return (
    <div className="mx-4 mb-2 space-y-2">
      {notices.map(({ key, icon: Icon, lines }) => (
        <Notice
          key={`${key}:${lines[0]}`}
          role="status"
          aria-live="polite"
          className="animate-in fade-in flex items-start gap-2 duration-150 ease-out motion-reduce:animate-none"
        >
          {/* mt-0.5 centres the 16px icon on the first 20px line, at any width. */}
          <Icon aria-hidden className="text-muted-foreground mt-0.5 size-4 shrink-0" />
          <div>
            {lines.map((line) => (
              <p key={line}>{line}</p>
            ))}
          </div>
        </Notice>
      ))}
    </div>
  );
}
