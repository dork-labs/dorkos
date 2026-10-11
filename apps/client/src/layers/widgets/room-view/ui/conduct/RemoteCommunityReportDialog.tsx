import { useId, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  COMMUNITY_REPORT_NOTE_MAX_LENGTH,
  type CommunityReportReason,
} from '@dorkos/shared/community-adapter';
import type { RemoteCommunityEntry } from '@dorkos/shared/community-views';
import { useTransport } from '@/layers/shared/model';
import {
  Button,
  Label,
  RadioGroup,
  RadioGroupItem,
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  Textarea,
} from '@/layers/shared/ui';

/** Each reason, in the words a person picks it by. */
const REASONS: { value: CommunityReportReason; label: string }[] = [
  { value: 'spam', label: 'Spam' },
  { value: 'harassment', label: 'Harassment' },
  { value: 'off_topic', label: 'Off topic' },
  { value: 'illegal', label: 'Against the law' },
  { value: 'other', label: 'Something else' },
];

/**
 * Report someone else's message to the space's owners and admins: a reason, and a note only
 * they read. The reporter is never told what they did about it.
 */
export function RemoteCommunityReportDialog({
  entry,
  onClose,
}: {
  entry: RemoteCommunityEntry | null;
  onClose: () => void;
}) {
  return (
    <ResponsiveDialog open={entry !== null} onOpenChange={(open) => !open && onClose()}>
      <ResponsiveDialogContent className="sm:max-w-md">
        {entry && <ReportForm key={entry.id} entry={entry} onClose={onClose} />}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

function ReportForm({ entry, onClose }: { entry: RemoteCommunityEntry; onClose: () => void }) {
  const transport = useTransport();
  const ids = useId();
  const [reason, setReason] = useState<CommunityReportReason | null>(null);
  const [note, setNote] = useState('');
  const report = useMutation({
    mutationFn: (input: { reason: CommunityReportReason; note?: string }) =>
      transport.reportRemoteCommunityEntry(entry.community, entry.roomId, entry.id, input),
    onSuccess: () => {
      toast('Message reported');
      onClose();
    },
  });
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (reason) report.mutate({ reason, ...(note.trim() ? { note: note.trim() } : {}) });
      }}
    >
      <ResponsiveDialogHeader>
        <ResponsiveDialogTitle>Report message</ResponsiveDialogTitle>
        <ResponsiveDialogDescription>
          This space’s owners and admins review reports.
        </ResponsiveDialogDescription>
      </ResponsiveDialogHeader>
      <ResponsiveDialogBody className="space-y-4">
        <p className="text-muted-foreground line-clamp-3 text-sm">
          {entry.authorDisplayName}: {entry.text}
        </p>
        <RadioGroup
          aria-label="Reason"
          value={reason ?? ''}
          onValueChange={(value) => setReason(value as CommunityReportReason)}
        >
          {REASONS.map((item) => (
            <div key={item.value} className="flex items-center gap-2">
              <RadioGroupItem value={item.value} id={`${ids}-${item.value}`} />
              <Label htmlFor={`${ids}-${item.value}`}>{item.label}</Label>
            </div>
          ))}
        </RadioGroup>
        <div className="space-y-1.5">
          <Label htmlFor={`${ids}-note`}>Note (optional)</Label>
          <Textarea
            id={`${ids}-note`}
            value={note}
            maxLength={COMMUNITY_REPORT_NOTE_MAX_LENGTH}
            onChange={(event) => setNote(event.target.value)}
            rows={3}
          />
          <p className="text-muted-foreground text-xs">Only owners and admins see this.</p>
        </div>
        {report.error && (
          <p role="alert" className="text-destructive text-sm">
            {report.error instanceof Error && report.error.message
              ? report.error.message
              : 'Couldn’t send the report. Try again.'}
          </p>
        )}
      </ResponsiveDialogBody>
      <ResponsiveDialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={!reason || report.isPending}>
          {report.isPending ? 'Sending…' : 'Send report'}
        </Button>
      </ResponsiveDialogFooter>
    </form>
  );
}
