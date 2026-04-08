/**
 * Template picker with built-in templates, Dork Hub marketplace agents, and
 * a custom GitHub URL input.
 *
 * The top-level tabs switch between "Built-in" (category-filtered card grid)
 * and "From Dork Hub" (marketplace agent cards). The custom GitHub URL input
 * sits below the tabs and is always visible so users can bypass both template
 * sources at any time. Grid selection and URL input are mutually exclusive.
 */
import { useState } from 'react';
import { Check } from 'lucide-react';
import type { TemplateCategory } from '@dorkos/shared/template-catalog';
import { Button, Input, Label, Tabs, TabsList, TabsTrigger, TabsContent } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { useMarketplacePackages } from '@/layers/entities/marketplace';
import { useTemplateCatalog } from '../model/use-template-catalog';

const CATEGORY_TABS: Array<{ value: 'all' | TemplateCategory; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'general', label: 'General' },
  { value: 'frontend', label: 'Frontend' },
  { value: 'backend', label: 'Backend' },
  { value: 'library', label: 'Library' },
  { value: 'tooling', label: 'Tooling' },
];

interface TemplatePickerProps {
  /** Currently selected template ID, marketplace source URL, or custom URL — null if nothing selected. */
  selectedTemplate: string | null;
  /** Called when selection changes. Receives template ID, source URL, or null. */
  onSelect: (template: string | null) => void;
}

/**
 * Template picker with built-in, Dork Hub marketplace, and custom GitHub URL sources.
 *
 * Built-in templates pass their ID to `onSelect`. Marketplace agents and custom
 * URLs pass the git source URL so the downstream template downloader handles both
 * identically.
 */
export function TemplatePicker({ selectedTemplate, onSelect }: TemplatePickerProps) {
  const [category, setCategory] = useState<'all' | TemplateCategory>('all');
  const [customUrl, setCustomUrl] = useState('');
  const { data: templates } = useTemplateCatalog();
  const { data: marketplaceAgents, error: marketplaceError } = useMarketplacePackages({
    type: 'agent',
  });

  const filtered =
    category === 'all' ? templates : templates?.filter((t) => t.category === category);

  return (
    <div className="space-y-3">
      <Label>Template (optional)</Label>

      <Tabs defaultValue="builtin">
        <TabsList>
          <TabsTrigger value="builtin">Built-in</TabsTrigger>
          <TabsTrigger value="marketplace">From Dork Hub</TabsTrigger>
        </TabsList>

        {/* Built-in tab: category filter + template grid */}
        <TabsContent value="builtin" className="space-y-3">
          <div className="flex flex-wrap gap-1" role="tablist" aria-label="Template categories">
            {CATEGORY_TABS.map((tab) => (
              <Button
                key={tab.value}
                variant={category === tab.value ? 'default' : 'ghost'}
                size="sm"
                role="tab"
                aria-selected={category === tab.value}
                onClick={() => setCategory(tab.value)}
              >
                {tab.label}
              </Button>
            ))}
          </div>

          <div className="grid grid-cols-4 gap-2" data-testid="template-grid">
            {filtered?.map((template) => (
              <button
                key={template.id}
                type="button"
                onClick={() => {
                  onSelect(selectedTemplate === template.id ? null : template.id);
                  setCustomUrl('');
                }}
                className={cn(
                  'hover:border-primary rounded-lg border p-3 text-left transition-colors',
                  selectedTemplate === template.id && 'border-primary bg-primary/5'
                )}
                data-testid={`template-card-${template.id}`}
              >
                <p className="text-sm font-medium">{template.name}</p>
                <p className="text-muted-foreground line-clamp-2 text-xs">{template.description}</p>
                {selectedTemplate === template.id && (
                  <Check className="text-primary mt-1 size-4" aria-hidden />
                )}
              </button>
            ))}
          </div>
        </TabsContent>

        {/* Marketplace tab: agent packages from Dork Hub */}
        <TabsContent value="marketplace" className="space-y-3">
          {marketplaceError ? (
            <p className="text-muted-foreground py-8 text-center text-xs">
              Could not load marketplace agents. Check your network and marketplace sources in
              Settings.
            </p>
          ) : (marketplaceAgents ?? []).length === 0 ? (
            <p className="text-muted-foreground py-8 text-center text-xs">
              No marketplace agents available. Add a marketplace source in Settings.
            </p>
          ) : (
            <div className="grid grid-cols-4 gap-2" data-testid="marketplace-template-grid">
              {marketplaceAgents!.map((agent) => (
                <button
                  key={agent.name}
                  type="button"
                  onClick={() => {
                    onSelect(selectedTemplate === agent.source ? null : agent.source);
                    setCustomUrl('');
                  }}
                  className={cn(
                    'hover:border-primary rounded-lg border p-3 text-left transition-colors',
                    selectedTemplate === agent.source && 'border-primary bg-primary/5'
                  )}
                  data-testid={`marketplace-template-${agent.name}`}
                >
                  <p className="text-sm font-medium">{agent.name}</p>
                  {agent.description && (
                    <p className="text-muted-foreground line-clamp-2 text-xs">
                      {agent.description}
                    </p>
                  )}
                  {selectedTemplate === agent.source && (
                    <Check className="text-primary mt-1 size-4" aria-hidden />
                  )}
                </button>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* Custom URL input — always visible outside the tab system so tests and
          keyboard users can reach it without switching tabs */}
      <div className="space-y-1">
        <p className="text-muted-foreground text-xs">Or enter GitHub URL:</p>
        <Input
          value={customUrl}
          onChange={(e) => {
            const url = e.target.value;
            setCustomUrl(url);
            onSelect(url || null);
          }}
          placeholder="github.com/org/repo"
          data-testid="custom-url-input"
        />
      </div>
    </div>
  );
}
