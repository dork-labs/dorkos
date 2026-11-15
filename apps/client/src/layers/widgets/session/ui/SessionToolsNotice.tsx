import { Unplug } from 'lucide-react';
import { useSessionRow } from '@/layers/entities/session';
import { Notice } from '@/layers/shared/ui';

/** Show server-reported tool warnings, including when the conversation is reopened. */
export function SessionToolsNotice({ sessionId }: { sessionId: string | null }) {
  const { data: warnings } = useSessionRow(sessionId, { select: (session) => session.warnings });
  if (!warnings?.length) return null;
  return (
    <div className="mx-4 mb-2">
      {warnings.map((warning) => (
        <Notice key={warning.code} role="status" className="flex items-start gap-2">
          {/* mt-0.5 centres the 16px icon on the first 20px line, at any width. */}
          <Unplug aria-hidden className="text-muted-foreground mt-0.5 size-4 shrink-0" />
          <div>
            <p>{warning.message}</p>
            <p>Choose an agent when starting a chat to use DorkOS tools.</p>
          </div>
        </Notice>
      ))}
    </div>
  );
}
