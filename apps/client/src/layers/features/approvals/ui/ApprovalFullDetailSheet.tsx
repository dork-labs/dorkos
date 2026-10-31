import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import {
  Button,
  ResponsiveSheet,
  ResponsiveSheetContent,
  ResponsiveSheetDescription,
  ResponsiveSheetHeader,
  ResponsiveSheetTitle,
} from '@/layers/shared/ui';

export interface ApprovalFullDetailSheetProps {
  /** The approval whose full list this shows. */
  approvalId: string;
  /** Whether the sheet is open. */
  open: boolean;
  /** Called to open or close it. */
  onOpenChange: (open: boolean) => void;
  /** How long the full list is, from the summary, for the loading line. */
  length: number;
}

/**
 * The full list behind a Marketplace summary card (DOR-3070): everything the
 * approval is about, written out whole, exactly as the server stored it with
 * the card. Fetched only when opened, and never needed to decide: if it fails
 * to load, the card above still lists everything that gives the package
 * more power.
 */
export function ApprovalFullDetailSheet({
  approvalId,
  open,
  onOpenChange,
  length,
}: ApprovalFullDetailSheetProps) {
  const transport = useTransport();
  const query = useQuery({
    queryKey: ['approvals', 'full-detail', approvalId],
    queryFn: () => transport.getApprovalFullDetail(approvalId),
    enabled: open,
    staleTime: Infinity,
    retry: false,
  });

  return (
    <ResponsiveSheet open={open} onOpenChange={onOpenChange}>
      <ResponsiveSheetContent
        data-slot="approval-full-detail-sheet"
        className="flex flex-col gap-0 overflow-hidden p-0"
      >
        <ResponsiveSheetHeader className="border-border/60 border-b p-4">
          <ResponsiveSheetTitle>Everything it runs</ResponsiveSheetTitle>
          <ResponsiveSheetDescription>
            The whole list this approval covers, as DorkOS read it.
          </ResponsiveSheetDescription>
        </ResponsiveSheetHeader>
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {query.isPending ? (
            <p className="text-muted-foreground text-xs" role="status">
              Reading {length.toLocaleString()} characters…
            </p>
          ) : query.isError ? (
            <div role="alert" className="flex flex-col items-start gap-2 text-xs">
              <p>
                <span className="text-foreground font-medium">Couldn’t load the full list.</span>{' '}
                <span className="text-muted-foreground">
                  Everything that gives it more power is already on the card.
                </span>
              </p>
              <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
                Try again
              </Button>
            </div>
          ) : (
            <pre
              data-slot="approval-full-detail-text"
              className="text-foreground font-mono text-xs break-words whitespace-pre-wrap"
            >
              {query.data.text}
            </pre>
          )}
        </div>
      </ResponsiveSheetContent>
    </ResponsiveSheet>
  );
}
