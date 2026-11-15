import { useSessionRow } from '@/layers/entities/session';
import { Notice } from '@/layers/shared/ui';

/** Show server-reported tool warnings, including when the conversation is reopened. */
export function SessionToolsNotice({ sessionId }: { sessionId: string | null }) {
  const { data: warnings } = useSessionRow(sessionId, { select: (session) => session.warnings });
  if (!warnings?.length) return null;
  return (
    <div className="mx-4 mb-2">
      {warnings.map((warning) => (
        <Notice key={warning.code} role="status">
          <p>{warning.message}</p>
          <p>Choose an agent when starting a chat to use DorkOS tools.</p>
        </Notice>
      ))}
    </div>
  );
}
