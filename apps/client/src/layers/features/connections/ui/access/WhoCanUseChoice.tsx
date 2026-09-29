import { useId } from 'react';
import { Label, RadioGroup, RadioGroupItem } from '@/layers/shared/ui';
import type { WhoCanUse } from '../../lib/access-card-selection';

interface WhoCanUseChoiceProps {
  /** The current answer. */
  value: WhoCanUse;
  /** Change the answer. */
  onChange: (next: WhoCanUse) => void;
  /** Whether "Every agent" can be offered for this account. */
  everyAgentAvailable: boolean;
}

/**
 * The page card's first question (DOR-2420): "Only agents I pick" or "Every
 * agent (including agents you add later)". Never shown in the chat's one-agent
 * card, where the person is answering for one agent. Where "Every agent" can't
 * be offered — an app connected through a DorkOS account while this computer
 * cannot reach the service that keeps its access — it stays in view, disabled,
 * with the reason in plain words.
 */
export function WhoCanUseChoice({ value, onChange, everyAgentAvailable }: WhoCanUseChoiceProps) {
  const baseId = useId();
  return (
    <RadioGroup
      value={value}
      onValueChange={(next) => onChange(next as WhoCanUse)}
      aria-label="Who can use it"
      className="gap-1.5"
    >
      <div className="flex min-h-11 items-center gap-3 rounded-md px-2">
        <RadioGroupItem value="picked" id={`${baseId}-picked`} />
        <Label htmlFor={`${baseId}-picked`} className="flex-1 cursor-pointer py-2 font-normal">
          Only agents I pick
        </Label>
      </div>
      <div className="flex min-h-11 items-start gap-3 rounded-md px-2 py-2">
        <RadioGroupItem
          value="every"
          id={`${baseId}-every`}
          disabled={!everyAgentAvailable}
          aria-describedby={everyAgentAvailable ? undefined : `${baseId}-every-unavailable`}
          className="mt-0.5"
        />
        <Label
          htmlFor={`${baseId}-every`}
          className="flex-1 cursor-pointer flex-col items-start gap-0.5 font-normal"
        >
          <span>Every agent</span>
          <span className="text-muted-foreground text-xs">Including agents you add later</span>
          {!everyAgentAvailable && (
            <span id={`${baseId}-every-unavailable`} className="text-muted-foreground text-xs">
              Not available for this app right now. Pick agents one by one.
            </span>
          )}
        </Label>
      </div>
    </RadioGroup>
  );
}
