import { useState } from 'react';
import { AlertTriangle, ChevronDown } from 'lucide-react';
import {
  Badge,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  SettingRow,
  Switch,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import type { ToolDomainKey, ToolGroupDef } from '../../config/tool-inventory';
import { ToolCountBadge } from './ToolCountBadge';

interface ToolGroupRowProps {
  group: ToolGroupDef;
  enabled: boolean;
  available: boolean;
  initError?: string;
  overrideCount: number;
  onToggle: (key: ToolDomainKey, value: boolean) => void;
  /** Optional content shown when the row is expanded (e.g., scheduler settings). */
  expandContent?: React.ReactNode;
}

/** A single tool group row with switch, init error, override count, and tool inventory tooltip. */
export function ToolGroupRow({
  group,
  enabled,
  available,
  initError,
  overrideCount,
  onToggle,
  expandContent,
}: ToolGroupRowProps) {
  const [expanded, setExpanded] = useState(false);
  const hasExpand = !!expandContent;

  const controls = (
    <div className="flex items-center gap-2">
      {initError && (
        <Tooltip>
          <TooltipTrigger asChild>
            <AlertTriangle className="size-3.5 shrink-0 text-amber-500" />
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs">
            <p className="text-xs">{initError}</p>
          </TooltipContent>
        </Tooltip>
      )}
      {!available && !initError && (
        <Badge variant="secondary" className="text-xs">
          Disabled
        </Badge>
      )}
      {overrideCount > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-muted-foreground shrink-0 text-xs">
              {overrideCount} {overrideCount === 1 ? 'override' : 'overrides'}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p className="text-xs">
              {overrideCount} {overrideCount === 1 ? 'agent has' : 'agents have'} a per-agent
              override for this group
            </p>
          </TooltipContent>
        </Tooltip>
      )}
      <ToolCountBadge tools={group.tools} implicitNote={group.implicitNote} />
      <Switch
        checked={enabled}
        onCheckedChange={(v) => onToggle(group.key, v)}
        disabled={!available}
        aria-label={`Toggle ${group.label}`}
      />
      {hasExpand && (
        <CollapsibleTrigger asChild>
          <button
            className="text-muted-foreground hover:text-foreground rounded-sm p-0.5 transition-colors duration-150"
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${group.label} settings`}
          >
            <ChevronDown
              className={cn(
                'size-3.5 transition-transform duration-150',
                !expanded && '-rotate-90'
              )}
            />
          </button>
        </CollapsibleTrigger>
      )}
    </div>
  );

  const row = (
    <SettingRow label={group.label} description={group.description}>
      {controls}
    </SettingRow>
  );

  if (!hasExpand) return row;

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      {row}
      <CollapsibleContent>
        <div className="border-border mt-2 space-y-2 border-t pt-2">{expandContent}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}
