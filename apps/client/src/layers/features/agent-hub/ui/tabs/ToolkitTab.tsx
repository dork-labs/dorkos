import { useState } from 'react';
import { ChevronRight, ChevronDown, Package, Wrench } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import { Button } from '@/layers/shared/ui';
import { useNavigate } from '@tanstack/react-router';
import { ToolsTab as AgentToolsTab } from '@/layers/features/agent-settings';
import { useInstalledPackages, SkillPacksList } from '@/layers/entities/marketplace';
import { useAgentHubContext } from '../../model/agent-hub-context';

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
  const skillPackCount = packages?.filter((p) => p.type === 'skill-pack').length ?? 0;
  const navigate = useNavigate();

  const handleBrowseSkillPacks = () => {
    void navigate({ to: '/marketplace', search: { type: 'skill-pack' } });
  };

  return (
    <div data-slot="toolkit-tab" className="flex flex-col">
      <AccordionSection
        title="Skills"
        icon={Package}
        meta={skillPackCount > 0 ? `${skillPackCount}` : undefined}
        defaultOpen
      >
        <SkillPacksList projectPath={projectPath} />
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
