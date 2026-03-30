import { useState, useCallback } from 'react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { DEFAULT_TRAITS } from '@dorkos/shared/trait-renderer';
import { useTransport } from '@/layers/shared/model';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Button,
} from '@/layers/shared/ui';

interface ResetDorkBotDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Mesh agent ID for DorkBot, used to PATCH the existing agent. */
  dorkbotId: string;
}

/** Confirmation dialog that resets DorkBot's personality traits to their default values. */
export function ResetDorkBotDialog({ open, onOpenChange, dorkbotId }: ResetDorkBotDialogProps) {
  const transport = useTransport();
  const queryClient = useQueryClient();
  const [isPending, setIsPending] = useState(false);

  const handleReset = useCallback(async () => {
    setIsPending(true);
    try {
      await transport.updateMeshAgent(dorkbotId, { traits: DEFAULT_TRAITS });
      await queryClient.invalidateQueries({ queryKey: ['agents'] });
      await queryClient.invalidateQueries({ queryKey: ['mesh', 'agents'] });
      toast.success('DorkBot personality reset to defaults');
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to reset DorkBot personality');
    } finally {
      setIsPending(false);
    }
  }, [dorkbotId, transport, queryClient, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="reset-dorkbot-dialog">
        <DialogHeader>
          <DialogTitle>Reset DorkBot Personality</DialogTitle>
          <DialogDescription>
            Reset DorkBot&apos;s personality traits to their default values.
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleReset} disabled={isPending}>
            {isPending ? 'Resetting...' : 'Reset'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
