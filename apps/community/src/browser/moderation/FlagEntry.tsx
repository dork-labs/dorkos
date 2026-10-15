import { Button, Label, Textarea } from '@dork-labs/ui';
import { useId, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import type { CommunityWireReport } from '@dorkos/shared/community-wire';
import { describeError, request } from '../api.js';
import { FocusDialog } from '../components/FocusDialog.js';
import { REPORT_REASON_LABELS } from './ReportQueue.js';

/** The longest note a flag carries, as the server accepts it. */
export const FLAG_NOTE_MAX = 1000;

/**
 * Flag one message for the space's owners and admins, with a reason and an optional note. This
 * is the space's own queue; reporting illegal content to the server's admin is the separate
 * Report link. A second flag of the same message by the same person changes nothing.
 */
export function FlagEntry({ entryId, author }: { entryId: string; author: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<CommunityWireReport['reason']>('spam');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  async function send() {
    setBusy(true);
    setError('');
    try {
      await request(`/api/v1/entries/${entryId}/reports`, 'POST', {
        reason,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      setSent(true);
      setOpen(false);
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setBusy(false);
    }
  }
  if (sent)
    return (
      <span className="small muted mt-1" role="status">
        Flagged for moderators.
      </span>
    );
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        type="button"
        className="mt-1"
        aria-label={`Flag the message from ${author} for moderators`}
        onClick={() => setOpen(true)}
      >
        <ShieldAlert size={14} aria-hidden="true" /> Flag
      </Button>
      {open && (
        <FocusDialog title="Flag this message?" error={error} onClose={() => setOpen(false)}>
          <p>The space's owner and admins see it in their queue.</p>
          <div className="field">
            <Label htmlFor={`${id}-reason`}>Reason</Label>
            <select
              id={`${id}-reason`}
              value={reason}
              onChange={(event) => setReason(event.target.value as CommunityWireReport['reason'])}
            >
              {Object.entries(REPORT_REASON_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <Label htmlFor={`${id}-note`}>Note (optional)</Label>
            <Textarea
              id={`${id}-note`}
              maxLength={FLAG_NOTE_MAX}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
          <div className="row justify-end gap-2">
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button disabled={busy} onClick={() => void send()}>
              Flag
            </Button>
          </div>
        </FocusDialog>
      )}
    </>
  );
}
