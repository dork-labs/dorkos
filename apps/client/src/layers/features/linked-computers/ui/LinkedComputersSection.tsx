import type { HubComputerSummary, HubLinkCode } from '@dorkos/shared/session-relay-link';
import { Button, CopyButton } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { useLinkedComputers } from '../model/use-linked-computers';

/** The time a code stops working, as the person's clock shows it. */
function untilTime(expiresAt: string): string {
  const at = new Date(expiresAt);
  return Number.isNaN(at.getTime())
    ? ''
    : at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** The code just minted, with its copy button and when it stops working. */
function LinkCodeCard({ code, onDone }: { code: HubLinkCode; onDone: () => void }) {
  const until = untilTime(code.expiresAt);
  return (
    <div className="bg-muted space-y-2 rounded-md p-3">
      <p className="text-sm">Paste this code into DorkOS on the computer to link.</p>
      <div className="flex items-center gap-2">
        <code className="flex-1 truncate font-mono text-sm" data-testid="hub-link-code">
          {code.linkCode}
        </code>
        <CopyButton value={code.linkCode} label="Copy code" />
      </div>
      <div className="flex items-center justify-between gap-2">
        <p className="text-muted-foreground text-xs">
          {until ? `Works once, until ${until}.` : 'Works once, for 10 minutes.'}
        </p>
        <Button variant="ghost" size="sm" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}

/** One linked computer, with its Remove button. */
function ComputerRow({
  computer,
  removing,
  onRemove,
}: {
  computer: HubComputerSummary;
  removing: boolean;
  onRemove: () => void;
}) {
  const name = computer.computerName ?? computer.computerId;
  return (
    <li className="flex items-center justify-between gap-2">
      <div className="min-w-0">
        <p className="truncate text-sm">{name}</p>
        <p className="text-muted-foreground text-xs">
          {computer.connected ? 'Connected' : 'Not connected'}
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={onRemove}
        disabled={removing}
        aria-label={`Remove ${name}`}
      >
        Remove
      </Button>
    </li>
  );
}

/**
 * Linked computers (step B3, DOR-2946): on a hub, the computers its owner has
 * linked, a Remove button for each, and "Link a computer", which mints a
 * one-time code to paste into DorkOS on that computer. Renders nothing
 * anywhere but a hub.
 */
export function LinkedComputersSection({ className }: { className?: string }) {
  const linked = useLinkedComputers();
  if (!linked.isHub) return null;

  return (
    <section
      aria-labelledby="linked-computers-title"
      className={cn('border-border bg-muted/30 space-y-3 rounded-lg border p-4', className)}
    >
      <div className="flex items-center justify-between gap-4">
        <div>
          <p id="linked-computers-title" className="text-sm font-medium">
            Linked computers
          </p>
          <p className="text-muted-foreground text-xs">
            Chat with the agents on your own computers from here.
          </p>
        </div>
        <Button size="sm" onClick={linked.mint} disabled={linked.minting}>
          Link a computer
        </Button>
      </div>
      {linked.linkCode && <LinkCodeCard code={linked.linkCode} onDone={linked.dismissCode} />}
      {linked.error && (
        <p className="text-destructive text-xs" role="alert">
          {linked.error}
        </p>
      )}
      {linked.computers.length === 0 ? (
        <p className="text-muted-foreground text-xs">No computers linked yet.</p>
      ) : (
        <ul className="space-y-2">
          {linked.computers.map((computer) => (
            <ComputerRow
              key={computer.computerId}
              computer={computer}
              removing={linked.removing === computer.computerId}
              onRemove={() => linked.remove(computer.computerId)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
