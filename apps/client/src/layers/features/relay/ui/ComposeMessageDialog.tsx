import { useState } from 'react';
import { PenLine, Send } from 'lucide-react';
import { z } from 'zod';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogDescription,
} from '@/layers/shared/ui';
import { Button } from '@/layers/shared/ui';
import { useAppForm } from '@/layers/shared/lib/form';
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

const composeSchema = z.object({
  subject: z.string().min(1, 'Subject is required'),
  from: z.string().min(1, 'From is required'),
  payload: z.string().min(1, 'Payload is required'),
});

interface ComposeMessageDialogProps {
  /** Controlled open state. When provided, the trigger button is omitted. */
  open?: boolean;
  /** Controlled open-change handler. Required when `open` is provided. */
  onOpenChange?: (value: boolean) => void;
}

/** Dialog for composing and sending a test message through the Relay bus. */
export function ComposeMessageDialog({
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
}: ComposeMessageDialogProps = {}) {
  const [internalOpen, setInternalOpen] = useState(false);

  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;

  const sendMessage = useSendRelayMessage();

  const form = useAppForm({
    defaultValues: {
      subject: '',
      from: 'relay.human.console',
      payload: '',
    },
    validators: {
      onSubmit: composeSchema,
    },
    onSubmit: ({ value }) => {
      sendMessage.mutate(
        { subject: value.subject, from: value.from, payload: parsePayload(value.payload) },
        {
          onSuccess: () => {
            toast.success('Message sent');
            form.reset();
            handleOpenChange(false);
          },
        }
      );
    },
  });

  function handleOpenChange(value: boolean) {
    if (isControlled) {
      controlledOnOpenChange?.(value);
    } else {
      setInternalOpen(value);
    }
    if (!value) form.reset();
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
          <DialogDescription>Compose a message to send through the Relay bus.</DialogDescription>
        </DialogHeader>
        <form.AppForm>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void form.handleSubmit();
            }}
            className="space-y-4"
          >
            <form.AppField name="subject">
              {(field) => <field.TextField label="Subject" placeholder="e.g. relay.test.ping" />}
            </form.AppField>
            <form.AppField name="from">{(field) => <field.TextField label="From" />}</form.AppField>
            <form.AppField name="payload">
              {(field) => (
                <field.TextareaField
                  label="Payload"
                  placeholder='Plain text or JSON (e.g. {"content": "hello"})'
                  rows={4}
                />
              )}
            </form.AppField>
            <div className="flex justify-end">
              <Button type="submit" disabled={sendMessage.isPending}>
                <Send className="mr-2 size-4" />
                Send
              </Button>
            </div>
          </form>
        </form.AppForm>
      </DialogContent>
    </Dialog>
  );
}
