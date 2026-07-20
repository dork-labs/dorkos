import { useMemo, useState } from 'react';
import { ChevronDown, FolderInput, Sparkles } from 'lucide-react';
import {
  Input,
  Button,
  Skeleton,
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from '@/layers/shared/ui';
import { cn, humanizePackageName, packageDisplayLabel } from '@/layers/shared/lib';
import { useMarketplacePackages } from '@/layers/entities/marketplace';
import type { AggregatedPackage } from '@dorkos/shared/marketplace-schemas';
import { DEFAULT_AGENT_FACE } from '../lib/agent-faces';
import { useRovingFocus } from '../lib/use-roving-focus';
import type { SelectedTemplate } from '../lib/wizard-types';
import { GalleryCard } from './GalleryCard';

/** Props for {@link AgentGallery}. */
export interface AgentGalleryProps {
  /** Start the blank, describe-it-yourself path (design-your-own card). */
  onDesignYourOwn: () => void;
  /** A ready-made template was chosen. */
  onSelectTemplate: (template: SelectedTemplate) => void;
  /** Leave the creation fork to bring in an existing project. */
  onImport: () => void;
}

/** Distill a marketplace package into the naming step's template shape. */
function toSelectedTemplate(pkg: AggregatedPackage): SelectedTemplate {
  return {
    source: pkg.source,
    name: pkg.name,
    displayName: packageDisplayLabel(pkg),
    description: pkg.description,
    icon: pkg.icon,
    tags: pkg.tags,
    category: pkg.category,
  };
}

/** Up to two honest chips from a package's tags or category. */
function deriveChips(pkg: AggregatedPackage): string[] {
  if (pkg.tags && pkg.tags.length > 0) return pkg.tags.slice(0, 2);
  if (pkg.category) return [pkg.category];
  return [];
}

/** Derive the URL's last path segment as a slug for a custom-source template. */
function slugFromUrl(url: string): string {
  const trimmed = url.replace(/\/+$/, '');
  return trimmed.split('/').pop() ?? trimmed;
}

/**
 * The gallery (M2): the generic entry to agent creation. "Design your own"
 * leads; ready-made agents follow as job listings. A quiet footer link brings
 * in an existing project, and an advanced disclosure accepts a custom template
 * URL. Cards are arrow-navigable via a roving tabindex.
 *
 * @param props - Selection handlers for design-your-own, a template, or import.
 */
export function AgentGallery({ onDesignYourOwn, onSelectTemplate, onImport }: AgentGalleryProps) {
  const { data: allPackages, error, isLoading } = useMarketplacePackages();
  const [customUrl, setCustomUrl] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const templates = useMemo(
    () => (allPackages ?? []).filter((pkg) => pkg.type === 'agent'),
    [allPackages]
  );

  // The focusable cards, in order: design-your-own first, then each template.
  const roving = useRovingFocus(templates.length + 1);

  return (
    <div className="space-y-5">
      <div
        role="group"
        aria-label="Choose what your agent will do"
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
        data-testid="agent-gallery"
      >
        {/* Design your own — always first, always available. */}
        <GalleryCard
          ref={roving.setRef(0)}
          variant="design"
          face={<Sparkles className="text-primary size-7" />}
          title="Design your own"
          subtitle="Describe the job in your own words — your agent takes shape as you talk to it."
          tabIndex={roving.tabIndexFor(0)}
          onSelect={onDesignYourOwn}
          onKeyDown={(e) => roving.handleKeyDown(e, 0)}
          data-testid="gallery-design-your-own"
        />

        {/* Ready-made agents, as job listings. */}
        {templates.map((pkg, i) => {
          const index = i + 1;
          return (
            <GalleryCard
              key={pkg.name}
              ref={roving.setRef(index)}
              variant="template"
              face={pkg.icon ?? DEFAULT_AGENT_FACE}
              title={packageDisplayLabel(pkg)}
              subtitle={pkg.description ?? 'A ready-made agent.'}
              chips={deriveChips(pkg)}
              tabIndex={roving.tabIndexFor(index)}
              onSelect={() => onSelectTemplate(toSelectedTemplate(pkg))}
              onKeyDown={(e) => roving.handleKeyDown(e, index)}
              data-testid={`gallery-template-${pkg.name}`}
            />
          );
        })}

        {/* Loading placeholders while the catalog resolves. */}
        {isLoading &&
          templates.length === 0 &&
          Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-xl" data-testid="gallery-skeleton" />
          ))}
      </div>

      {/* Honest note when the catalog is empty or unreachable — design-your-own still leads. */}
      {!isLoading && templates.length === 0 && (
        <p
          className="text-muted-foreground text-center text-xs"
          data-testid="gallery-templates-note"
        >
          {error
            ? 'Could not load ready-made agents. Check your marketplace sources in Settings — you can still design your own above.'
            : 'No ready-made agents yet — design your own above, or add a marketplace source in Settings.'}
        </p>
      )}

      {/* Advanced: build from a custom template URL. */}
      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs transition-colors"
            data-testid="advanced-toggle"
          >
            <ChevronDown
              className={cn('size-3.5 transition-transform', advancedOpen && 'rotate-180')}
            />
            Build from a template URL
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
                const slug = slugFromUrl(customUrl);
                onSelectTemplate({
                  source: customUrl,
                  name: slug,
                  displayName: humanizePackageName(slug),
                });
                setCustomUrl('');
              }}
              data-testid="custom-url-go"
            >
              Continue
            </Button>
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* Import lead-out — leaves the creation fork. */}
      <div className="border-t pt-3">
        <button
          type="button"
          onClick={onImport}
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-sm transition-colors"
          data-testid="gallery-import-link"
        >
          <FolderInput className="size-4" />
          Already have a project folder on disk? Bring in an existing project
          <span aria-hidden>→</span>
        </button>
      </div>
    </div>
  );
}
