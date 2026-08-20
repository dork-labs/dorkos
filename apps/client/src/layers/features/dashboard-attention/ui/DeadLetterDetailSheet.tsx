import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
  Badge,
  Button,
  ScrollArea,
} from '@/layers/shared/ui';
import { useAggregatedDeadLetters, useDismissDeadLetterGroup } from '@/layers/entities/relay';
import { formatCompactAge } from '@/layers/shared/lib';

interface DeadLetterDetailSheetProps {
  open: boolean;
  itemId: string | undefined;
  onClose: () => void;
}

/**
 * Detail sheet for a dead letter group, showing message count, reason,
 * timestamps, sample payload, and a dismiss action.
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
          <SheetTitle>Dead Letters</SheetTitle>
          <SheetDescription>{source ?? 'Unknown source'}</SheetDescription>
        </SheetHeader>

        <ScrollArea className="flex-1 px-4">
          {group ? (
            <div className="space-y-4">
              {/* Summary */}
              <div className="space-y-2">
                <p className="text-foreground text-sm">
                  {group.count} undeliverable message{group.count === 1 ? '' : 's'}
                </p>
                <Badge variant="secondary">{group.reason}</Badge>
              </div>

              {/* Timestamps */}
              <div className="space-y-1 text-sm">
                <p className="text-muted-foreground">
                  First seen: {formatCompactAge(group.firstSeen)} ago
                </p>
                <p className="text-muted-foreground">
                  Last seen: {formatCompactAge(group.lastSeen)} ago
                </p>
              </div>

              {/* Sample payload */}
              {group.sample != null && (
                <div className="space-y-1">
                  <p className="text-muted-foreground text-xs font-medium">Sample payload</p>
                  <pre className="bg-muted overflow-x-auto rounded-md p-3 font-mono text-xs">
                    {JSON.stringify(group.sample, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          ) : (
            <p className="text-muted-foreground py-8 text-center text-sm">
              This item has been resolved.
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
              {dismissMutation.isPending ? 'Dismissing...' : 'Dismiss Group'}
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
