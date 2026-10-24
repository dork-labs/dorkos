import { Pause } from 'lucide-react';
import type { PausedConnectionItem } from '@/layers/entities/attention';
import {
  pausedNotSent,
  pausedRowHint,
  pausedRowMeta,
  useConfirmAdapterReferences,
} from '@/layers/entities/relay';
import { InboxDecisionRow } from '@/layers/features/inbox';

/** Props for {@link PausedConnectionList}. */
export interface PausedConnectionListProps {
  /** Connections paused until their owner confirms what they send. */
  items: readonly PausedConnectionItem[];
}

/**
 * Needs you rows for connections paused after the DOR-3271 update (designer
 * spec `adapter-confirm`): one per connection, with what it sends and where,
 * what it dropped meanwhile, and the same Confirm the connection's own panel
 * has. Only the owner can answer it, so it counts toward the badge. A row
 * leaves when the connection is confirmed, removed, or edited to drop the
 * setting, because the catalog stops listing it.
 */
export function PausedConnectionList({ items }: PausedConnectionListProps) {
  const confirm = useConfirmAdapterReferences();
  if (items.length === 0) return null;
  return (
    <div data-slot="paused-connection-list" className="mt-2 flex flex-col gap-1">
      {items.map((item) => {
        const notSent = pausedNotSent(item.confirmation.notSent);
        return (
          <InboxDecisionRow
            key={`${item.id}:${item.confirmation.fingerprint}`}
            icon={Pause}
            title={`${item.name} is paused`}
            why="Paused · confirm the setting it sends."
            sourceLine={pausedRowMeta(item.kind, item.confirmation)}
            {...(notSent ? { meta: notSent } : {})}
            details={
              <p className="text-muted-foreground text-xs">{pausedRowHint(item.confirmation)}</p>
            }
            actions={{
              kind: 'word',
              label: 'Confirm this setting',
              onClick: () =>
                confirm.mutate({
                  id: item.id,
                  name: item.name,
                  fingerprint: item.confirmation.fingerprint,
                }),
            }}
            pending={confirm.isPending && confirm.variables?.id === item.id ? 'word' : null}
          />
        );
      })}
    </div>
  );
}
