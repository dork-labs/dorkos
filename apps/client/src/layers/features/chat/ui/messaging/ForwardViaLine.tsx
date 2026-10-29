/**
 * "via {app} · {item}", the muted line above a comment the person typed in a
 * mini app and DorkOS forwarded into this chat for them (DOR-3325).
 *
 * It sits outside the message, never in its text: only the typed words are
 * the person's. The item's title is the app's own label (often written by an
 * agent), so it shows in quotes, as data from the app, with the app named.
 *
 * @module features/chat/ui/messaging/ForwardViaLine
 */
import type { ForwardVia } from '@dorkos/shared/chat-messages';

/**
 * The app and item a forwarded comment came from.
 *
 * @param props.via - The provenance the server put on the message.
 */
export function ForwardViaLine({ via }: { via: ForwardVia }) {
  return (
    <p
      data-testid="forward-via-line"
      className="text-muted-foreground mb-0.5 flex min-w-0 items-center gap-1 text-xs"
    >
      <span className="shrink-0">via {via.appName}</span>
      <span aria-hidden>·</span>
      {via.itemTitle ? (
        <q className="min-w-0 truncate" title={`Item title from ${via.appName}`}>
          {via.itemTitle}
        </q>
      ) : (
        <span className="min-w-0 truncate">item {via.itemId}</span>
      )}
    </p>
  );
}
