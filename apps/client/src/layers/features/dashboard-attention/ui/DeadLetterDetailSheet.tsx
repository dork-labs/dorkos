import { ChevronRight } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
  Badge,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  ScrollArea,
} from '@/layers/shared/ui';
import {
  useAggregatedDeadLetters,
  useDismissDeadLetterGroup,
  deadLetterReasonLabel,
} from '@/layers/entities/relay';
import { formatCompactAge } from '@/layers/shared/lib';

interface DeadLetterDetailSheetProps {
  open: boolean;
  itemId: string | undefined;
  onClose: () => void;
}

/**
 * Detail sheet for a group of messages that never reached their agent, showing
 * how many there were, why, when they happened, one example, and a way to clear
 * them.
 *
 * The copy deliberately says none of "dead letter", "undeliverable", "payload"
 * or "envelope" (DOR-1755), and that includes the reason itself: `group.reason`
 * is a wire enum (`hop_limit`, `ttl_expired`, ...) and this sheet runs it
 * through `deadLetterReasonLabel` before it renders, because the reason is the
 * one thing on the sheet that says why the messages failed. This sheet opens
 * straight off Home, so it can be one of the first things a person sees, and
 * message-broker vocabulary left them unable to tell whether anything was
 * wrong, whose fault it was, or what clearing would do.
 */
export function DeadLetterDetailSheet({ open, itemId, onClose }: DeadLetterDetailSheetProps) {
  const { data: deadLetters } = useAggregatedDeadLetters();
  const dismissMutation = useDismissDeadLetterGroup();

  // Parse compound key: "source::reason" — split on first "::" only
  const separatorIndex = itemId?.indexOf('::') ?? -1;
  const source = separatorIndex >= 0 ? itemId!.slice(0, separatorIndex) : undefined;
  const reason = separatorIndex >= 0 ? itemId!.slice(separatorIndex + 2) : undefined;

  // Find matching group from cached data
  const group = deadLetters?.find((g) => g.source === source && g.reason === reason);

  const handleDismiss = () => {
    if (!source || !reason) return;
    dismissMutation.mutate({ source, reason }, { onSuccess: onClose });
  };

  return (
    <Sheet open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>Messages that never arrived</SheetTitle>
          <SheetDescription>{source ?? 'We don’t know where these came from'}</SheetDescription>
        </SheetHeader>

        <ScrollArea className="flex-1 px-4">
          {group ? (
            <div className="space-y-4">
              {/* Summary */}
              <div className="space-y-2">
                <p className="text-muted-foreground text-sm">
                  These messages were meant for an agent and never got there. Clearing them does not
                  send them.
                </p>
                <p className="text-foreground text-sm">
                  {group.count} message{group.count === 1 ? '' : 's'} couldn&rsquo;t be delivered
                </p>
                <Badge variant="secondary">{deadLetterReasonLabel(group.reason)}</Badge>
              </div>

              {/* Timestamps */}
              <div className="space-y-1 text-sm">
                <p className="text-muted-foreground">
                  First happened {formatCompactAge(group.firstSeen)} ago
                </p>
                <p className="text-muted-foreground">
                  Last happened {formatCompactAge(group.lastSeen)} ago
                </p>
              </div>

              {/* One example, folded away: it is raw JSON, useful to whoever
                  wants it and noise to everyone else. */}
              {group.sample != null && (
                <Collapsible>
                  <CollapsibleTrigger className="text-muted-foreground hover:text-foreground group flex items-center gap-1 text-xs font-medium transition-colors">
                    <ChevronRight className="size-3 transition-transform group-data-[state=open]:rotate-90" />
                    What one of them looked like
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <pre className="bg-muted mt-1 overflow-x-auto rounded-md p-3 font-mono text-xs">
                      {JSON.stringify(group.sample, null, 2)}
                    </pre>
                  </CollapsibleContent>
                </Collapsible>
              )}
            </div>
          ) : (
            <p className="text-muted-foreground py-8 text-center text-sm">
              These are cleared already.
            </p>
          )}
        </ScrollArea>

        <SheetFooter>
          {group && (
            <Button
              variant="destructive"
              onClick={handleDismiss}
              disabled={dismissMutation.isPending}
            >
              {dismissMutation.isPending ? 'Clearing…' : 'Clear these'}
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
