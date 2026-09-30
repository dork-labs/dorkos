import { ShieldAlert } from 'lucide-react';
import type { ConnectorReconciliationPreview } from '@dorkos/shared/connector-schemas';
import {
  everyAgentHoldsHighRisk,
  everyAgentCanWrite,
  type CardAccessLevel,
} from '../../lib/access-card-selection';
import { everyAgentWriteWarning } from './access-labels';

/**
 * The one plain warning "Every agent" shows when every agent — including ones
 * added later — could write, and says delete too when it could delete (ADR
 * 260926-192625). Renders nothing for read-only.
 *
 * @param props - The snapshot, the chosen level, and the app's display name.
 */
export function EveryAgentWarning({
  preview,
  level,
  serviceName,
}: {
  preview: ConnectorReconciliationPreview;
  level: CardAccessLevel | null;
  serviceName: string;
}) {
  if (!everyAgentCanWrite(preview, level)) return null;
  return (
    <p
      role="note"
      data-testid="every-agent-warning"
      className="border-status-warning-border bg-status-warning-bg text-foreground flex items-start gap-2 rounded-lg border px-3 py-2 text-xs"
    >
      <ShieldAlert className="text-status-warning-dot mt-0.5 size-3.5 shrink-0" aria-hidden />
      {everyAgentWriteWarning(
        preview.connection.toolkit,
        serviceName,
        everyAgentHoldsHighRisk(preview, level)
      )}
    </p>
  );
}
