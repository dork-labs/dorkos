/**
 * What an extension gives agents, drawn the same way wherever a person
 * decides about it (DOR-2685): one summary line, and the rows under it.
 *
 * @module entities/extension/ui/ExtensionAgentGifts
 */
import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { AGENT_TOOL_TIER_LABEL, agentGiftsLine, type AgentGifts } from '../lib/agent-gifts';

/** Props for {@link ExtensionAgentGifts}. */
export interface ExtensionAgentGiftsProps {
  /** Every tool and skill the extension declares. */
  gifts: AgentGifts;
  /**
   * `disclosure` (the Settings card): the line is a toggle that opens the
   * rows. `list` (inside a panel that is already open): the line, then the rows.
   */
  variant?: 'disclosure' | 'list';
  /** Test id for the wrapper. */
  'data-testid'?: string;
  /** Chrome for the wrapper. */
  className?: string;
}

/** One row's muted second line, for a tool or skill that never reaches agents. */
function LeftOut({ reason }: { reason: string }) {
  return (
    <span className="text-muted-foreground block text-xs break-words">Left out: {reason}</span>
  );
}

/** The rows: each tool with what its tier means, then each skill. */
function GiftRows({ gifts }: { gifts: AgentGifts }) {
  return (
    <ul className="space-y-1.5 text-xs" data-slot="extension-agent-gift-rows">
      {gifts.tools.map((tool) => (
        <li key={`tool:${tool.name}`} className="min-w-0">
          {tool.leftOutReason === undefined ? (
            <span className="flex flex-wrap items-baseline gap-x-1.5">
              <span className="text-foreground break-words">{tool.title}</span>
              <span className="text-muted-foreground">{AGENT_TOOL_TIER_LABEL[tool.tier]}</span>
            </span>
          ) : (
            <>
              {/* A refused tool's title was never checked, so its name stands in. */}
              <span className="text-muted-foreground font-mono break-all">{tool.name}</span>
              <LeftOut reason={tool.leftOutReason} />
            </>
          )}
        </li>
      ))}
      {gifts.skills.map((skill) => (
        <li key={`skill:${skill.name}`} className="min-w-0">
          <span className="flex flex-wrap items-baseline gap-x-1.5">
            <span
              className={cn(
                'font-mono break-all',
                skill.leftOutReason === undefined ? 'text-foreground' : 'text-muted-foreground'
              )}
            >
              {skill.name}
            </span>
            <span className="text-muted-foreground">Skill</span>
          </span>
          {skill.leftOutReason !== undefined && <LeftOut reason={skill.leftOutReason} />}
        </li>
      ))}
    </ul>
  );
}

/**
 * "Gives agents 3 tools and 1 skill", and under it each tool's title with
 * what its tier means ("Reads", "Acts", "Asks you first") and each skill's
 * name. A tool DorkOS refused, or a skill it left out, is listed with the
 * reason in muted text and never counted. Draws nothing for an extension that
 * declares no tools and no skills.
 *
 * @param props - What it declares, and how to draw it.
 */
export function ExtensionAgentGifts({
  gifts,
  variant = 'disclosure',
  'data-testid': testId,
  className,
}: ExtensionAgentGiftsProps) {
  const [open, setOpen] = useState(false);
  const line = agentGiftsLine(gifts);
  if (line === null) return null;

  if (variant === 'list') {
    return (
      <div className={cn('space-y-1.5', className)} data-testid={testId}>
        <p className="text-foreground text-xs font-medium">{line}</p>
        <GiftRows gifts={gifts} />
      </div>
    );
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} className={className} data-testid={testId}>
      <CollapsibleTrigger className="text-muted-foreground hover:text-foreground focus-ring -mx-1 inline-flex min-h-6 items-center gap-1 rounded-sm px-1 text-xs transition-colors duration-150">
        {line}
        <ChevronDown
          aria-hidden
          className={cn(
            'size-3.5 shrink-0 motion-safe:transition-transform motion-safe:duration-150',
            open && 'rotate-180'
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="pt-1.5">
          <GiftRows gifts={gifts} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
