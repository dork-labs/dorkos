import { useState, useCallback } from 'react';
import { toast } from 'sonner';
import { TRAIT_ORDER, TRAIT_LEVELS, type TraitName } from '@dorkos/shared/trait-renderer';
import type { Traits } from '@dorkos/shared/mesh-schemas';
import { playSliderTick } from '@/layers/shared/lib';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Button,
  Label,
  Slider,
} from '@/layers/shared/ui';
import { useCreateAgent } from '@/layers/features/agent-creation';

const DEFAULT_TRAITS: Traits = {
  tone: 3,
  autonomy: 3,
  caution: 3,
  communication: 3,
  creativity: 3,
};

interface RecreateDorkBotDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Simplified creation dialog for DorkBot — personality sliders only, no name or template. */
export function RecreateDorkBotDialog({ open, onOpenChange }: RecreateDorkBotDialogProps) {
  const [traits, setTraits] = useState<Traits>({ ...DEFAULT_TRAITS });
  const createAgent = useCreateAgent();

  const handleTraitChange = useCallback((traitName: TraitName, value: number) => {
    playSliderTick();
    setTraits((prev) => ({ ...prev, [traitName]: value }));
  }, []);

  const handleRecreate = useCallback(async () => {
    try {
      await createAgent.mutateAsync({
        name: 'dorkbot',
        traits,
        conventions: { soul: true, nope: true, dorkosKnowledge: true },
      });
      toast.success('DorkBot recreated');
      onOpenChange(false);
      setTraits({ ...DEFAULT_TRAITS });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to recreate DorkBot');
    }
  }, [traits, createAgent, onOpenChange]);

  function handleOpenChange(next: boolean) {
    if (!next) {
      setTraits({ ...DEFAULT_TRAITS });
    }
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="recreate-dorkbot-dialog">
        <DialogHeader>
          <DialogTitle>Recreate DorkBot</DialogTitle>
          <DialogDescription>
            Configure DorkBot&apos;s personality. All settings can be changed later.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4" data-testid="dorkbot-personality-section">
          {TRAIT_ORDER.map((traitName) => {
            const level = traits[traitName] ?? 3;
            const entry = TRAIT_LEVELS[traitName][level];

            return (
              <div key={traitName} className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-medium capitalize">{traitName}</Label>
                  <span className="text-muted-foreground text-xs">
                    {level}/5 {entry.label}
                  </span>
                </div>
                <Slider
                  value={[level]}
                  onValueChange={([v]) => handleTraitChange(traitName, v)}
                  min={1}
                  max={5}
                  step={1}
                  aria-label={`${traitName} trait level`}
                />
              </div>
            );
          })}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleRecreate} disabled={createAgent.isPending}>
            {createAgent.isPending ? 'Recreating...' : 'Recreate'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
