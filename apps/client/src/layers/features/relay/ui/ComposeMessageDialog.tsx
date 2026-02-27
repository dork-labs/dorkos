import { useState } from 'react';
import { PenLine, Loader2, Send } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogDescription,
} from '@/layers/shared/ui';
import { Button } from '@/layers/shared/ui';
import { Input } from '@/layers/shared/ui';
import { Label } from '@/layers/shared/ui';
import { Textarea } from '@/layers/shared/ui';
import { useSendRelayMessage } from '@/layers/entities/relay';
import { toast } from 'sonner';

/** Parse raw payload text as JSON, or wrap as `{ content }` if it is plain text. */
function parsePayload(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { content: raw };
  }
}

interface ComposeMessageDialogProps {
  /** Controlled open state. When provided, the trigger button is omitted. */
  open?: boolean;
  /** Controlled open-change handler. Required when `open` is provided. */
  onOpenChange?: (value: boolean) => void;
}

/** Dialog for composing and sending a test message through the Relay bus. */
export function ComposeMessageDialog({ open: controlledOpen, onOpenChange: controlledOnOpenChange }: ComposeMessageDialogProps = {}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const [subject, setSubject] = useState('');
  const [from, setFrom] = useState('relay.human.console');
  const [payload, setPayload] = useState('');
  const [error, setError] = useState<string | null>(null);

  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;

  const sendMessage = useSendRelayMessage();

  function resetForm() {
    setSubject('');
    setFrom('relay.human.console');
    setPayload('');
    setError(null);
  }

  function handleOpenChange(value: boolean) {
    if (isControlled) {
      controlledOnOpenChange?.(value);
    } else {
      setInternalOpen(value);
    }
    if (!value) resetForm();
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    sendMessage.mutate(
      { subject, from, payload: parsePayload(payload) },
      {
        onSuccess: () => {
          toast.success('Message sent');
          resetForm();
          handleOpenChange(false);
        },
        onError: (err) => {
          setError(err instanceof Error ? err.message : 'Failed to send message');
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {!isControlled && (
        <DialogTrigger asChild>
          <Button variant="ghost" size="sm" className="gap-1.5" data-testid="compose-trigger">
            <PenLine className="size-3.5" />
            Compose
          </Button>
        </DialogTrigger>
      )}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send Test Message</DialogTitle>
          <DialogDescription>
            Compose a message to send through the Relay bus.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="compose-subject">Subject</Label>
            <Input
              id="compose-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="e.g. relay.test.ping"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="compose-from">From</Label>
            <Input
              id="compose-from"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="compose-payload">Payload</Label>
            <Textarea
              id="compose-payload"
              value={payload}
              onChange={(e) => setPayload(e.target.value)}
              placeholder='Plain text or JSON (e.g. {"content": "hello"})'
              rows={4}
            />
          </div>
          {error !== null && (
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          )}
          <div className="flex justify-end">
            <Button type="submit" disabled={sendMessage.isPending}>
              {sendMessage.isPending ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : (
                <Send className="mr-2 size-4" />
              )}
              Send
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
