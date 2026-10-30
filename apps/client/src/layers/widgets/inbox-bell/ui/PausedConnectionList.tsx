import { Pause } from 'lucide-react';
import type { PausedConnectionItem } from '@/layers/entities/attention';
import {
  pausedConfirmLabel,
  pausedReferenceList,
  pausedRowHint,
  pausedRowMeta,
  pausedRowNotice,
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
 * spec `adapter-confirm`): one per connection, two lines under its title (what
 * Confirm does, led by what it dropped meanwhile; then what it sends and
 * where), and the same Confirm the connection's own panel has. Confirm sits
 * under the text, full width and 44px tall, so it is easy to hit on a phone
 * (DOR-3288). The longer hint sits behind ⓘ and stays the button's
 * description. Only the owner can answer it, so it counts toward the badge. A
 * row leaves when the connection is confirmed, removed, or edited to drop the
 * setting, because the catalog stops listing it.
 */
export function PausedConnectionList({ items }: PausedConnectionListProps) {
  const confirm = useConfirmAdapterReferences();
  if (items.length === 0) return null;
  return (
    <div data-slot="paused-connection-list" className="mt-2 flex flex-col gap-1">
      {items.map((item) => {
        const hint = pausedRowHint(item.confirmation);
        return (
          <InboxDecisionRow
            key={`${item.id}:${item.confirmation.fingerprint}`}
            icon={Pause}
            title={`${item.name} is paused`}
            why={pausedRowNotice(item.confirmation.notSent)}
            sourceLine={pausedRowMeta(item.kind, item.confirmation)}
            sourceTitle={pausedReferenceList(item.confirmation)}
            more={<p>{hint}</p>}
            actions={{
              kind: 'word',
              block: true,
              label: pausedConfirmLabel(item.confirmation),
              description: hint,
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
