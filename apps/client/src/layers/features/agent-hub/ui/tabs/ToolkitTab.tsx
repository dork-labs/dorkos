import { useState } from 'react';
import { ChevronRight, ChevronDown, Package, Wrench } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import { Button } from '@/layers/shared/ui';
import { ToolsTab as AgentToolsTab } from '@/layers/features/agent-settings';
import { useDorkHubStore } from '@/layers/features/marketplace/model/dork-hub-store';
import { useInstalledPackages } from '@/layers/entities/marketplace';
import { useAgentHubContext } from '../../model/agent-hub-context';
import { ScopeBadge } from '../ScopeBadge';

// ---------------------------------------------------------------------------
// AccordionSection — copied from ConfigTab (same pattern, same file boundary)
// ---------------------------------------------------------------------------

interface AccordionSectionProps {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  meta?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

function AccordionSection({
  title,
  icon: Icon,
  meta,
  defaultOpen = false,
  children,
}: AccordionSectionProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className="border-b last:border-b-0">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          'hover:bg-accent/50 flex w-full items-center gap-2 px-4 py-2.5 text-left transition-colors'
        )}
        aria-expanded={isOpen}
      >
        {isOpen ? (
          <ChevronDown className="text-muted-foreground size-3.5 shrink-0" />
        ) : (
          <ChevronRight className="text-muted-foreground size-3.5 shrink-0" />
        )}
        <Icon className="text-muted-foreground size-3.5 shrink-0" />
        <span className="text-[11px] font-semibold">{title}</span>
        {meta && <span className="text-muted-foreground ml-auto text-[9px]">{meta}</span>}
      </button>
      {isOpen && <div className="px-4 pb-4">{children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// InstalledPackagesList — renders the installed packages for this agent
// ---------------------------------------------------------------------------

function InstalledPackagesList({ projectPath }: { projectPath: string }) {
  const { data: packages, isLoading, error } = useInstalledPackages(projectPath);

  if (isLoading) {
    return <p className="text-muted-foreground py-2 text-xs">Loading packages…</p>;
  }

  if (error) {
    return <p className="text-destructive py-2 text-xs">Failed to load packages.</p>;
  }

  if (!packages || packages.length === 0) {
    return (
      <p className="text-muted-foreground py-2 text-xs">No packages installed for this agent.</p>
    );
  }

  return (
    <ul className="space-y-1.5 py-1">
      {packages.map((pkg) => (
        <li key={pkg.name} className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{pkg.name}</span>
          {pkg.version && (
            <span className="text-muted-foreground shrink-0 text-[10px]">v{pkg.version}</span>
          )}
          <ScopeBadge scope={pkg.scope} />
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// ToolkitTab
// ---------------------------------------------------------------------------

/**
 * Toolkit tab for the Agent Hub panel.
 *
 * Shows installed marketplace packages scoped to this agent alongside the
 * agent's tool-group and MCP configuration (delegated to AgentToolsTab).
 */
export function ToolkitTab() {
  const { agent, projectPath, onUpdate } = useAgentHubContext();
  const { data: packages } = useInstalledPackages(projectPath);
  const packageCount = packages?.length ?? 0;

  const handleBrowseSkillPacks = () => {
    useDorkHubStore.getState().setTypeFilter('skill-pack');
    // TODO: open marketplace panel if not already open
  };

  return (
    <div data-slot="toolkit-tab" className="flex flex-col">
      <AccordionSection
        title="Skills"
        icon={Package}
        meta={packageCount > 0 ? `${packageCount}` : undefined}
        defaultOpen
      >
        <InstalledPackagesList projectPath={projectPath} />
        <Button
          variant="ghost"
          size="sm"
          onClick={handleBrowseSkillPacks}
          className="text-muted-foreground hover:text-foreground mt-2 w-full"
        >
          <Package className="mr-1.5 size-3.5" />
          Browse skill-packs
        </Button>
      </AccordionSection>

      <AccordionSection title="Tools & MCP" icon={Wrench}>
        <AgentToolsTab agent={agent} projectPath={projectPath} onUpdate={onUpdate} />
      </AccordionSection>
    </div>
  );
}
