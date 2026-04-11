/**
 * Template picker showing marketplace agent templates with an Advanced
 * section for custom GitHub URL input.
 *
 * Used inside the CreateAgentDialog wizard at the pick-template step.
 * Renders PackageCard compact variant in a 2-column grid. Clicking a
 * card fires onSelect with the source URL and package name.
 */
import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import {
  Input,
  Button,
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { useMarketplacePackages } from '@/layers/entities/marketplace';
import { PackageCard } from '@/layers/features/marketplace';

interface TemplatePickerProps {
  /** Called when a template is selected. Receives (source, name). Single click advances. */
  onSelect: (template: string | null, name?: string) => void;
}

/**
 * Template picker showing marketplace agent templates with an Advanced
 * section for custom GitHub URL input.
 */
export function TemplatePicker({ onSelect }: TemplatePickerProps) {
  const [customUrl, setCustomUrl] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const { data: marketplaceAgents, error: marketplaceError } = useMarketplacePackages({
    type: 'agent',
  });

  return (
    <div className="space-y-3">
      {/* Marketplace agent grid */}
      {marketplaceError ? (
        <p className="text-muted-foreground py-8 text-center text-xs">
          Could not load marketplace agents. Check your network and marketplace sources in Settings.
        </p>
      ) : (marketplaceAgents ?? []).length === 0 ? (
        <p className="text-muted-foreground py-8 text-center text-xs">
          No marketplace agents available. Add a marketplace source in Settings.
        </p>
      ) : (
        <div
          className="grid max-h-64 grid-cols-2 gap-3 overflow-y-auto"
          data-testid="marketplace-template-grid"
        >
          {marketplaceAgents!.map((agent) => (
            <PackageCard
              key={agent.name}
              pkg={agent}
              variant="compact"
              onClick={() => onSelect(agent.source, agent.name)}
              data-testid={`marketplace-template-${agent.name}`}
            />
          ))}
        </div>
      )}

      {/* Advanced: custom GitHub URL */}
      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground flex w-full items-center gap-1 text-sm transition-colors"
            data-testid="advanced-toggle"
          >
            <ChevronDown
              className={cn('size-4 transition-transform', advancedOpen && 'rotate-180')}
            />
            Advanced
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="flex items-center gap-2 pt-2">
            <Input
              value={customUrl}
              onChange={(e) => setCustomUrl(e.target.value)}
              placeholder="github.com/org/repo"
              data-testid="custom-url-input"
              className="flex-1"
            />
            <Button
              size="sm"
              disabled={!customUrl}
              onClick={() => {
                onSelect(customUrl);
                setCustomUrl('');
              }}
              data-testid="custom-url-go"
            >
              Go
            </Button>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
