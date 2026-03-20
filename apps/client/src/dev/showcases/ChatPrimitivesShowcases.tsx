import { useState } from 'react';
import { Check, X, ShieldCheck, MessageCircleQuestion } from 'lucide-react';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { Badge } from '@/layers/shared/ui';
import { CollapsibleCard } from '@/layers/features/chat/ui/primitives/CollapsibleCard';
import { InteractiveCard } from '@/layers/features/chat/ui/primitives/InteractiveCard';
import { OptionRow } from '@/layers/features/chat/ui/primitives/OptionRow';
import { CompactPendingRow } from '@/layers/features/chat/ui/primitives/CompactPendingRow';
import { CompactResultRow } from '@/layers/features/chat/ui/primitives/CompactResultRow';

/** Chat primitive component showcases: CollapsibleCard, InteractiveCard, OptionRow, CompactPendingRow, CompactResultRow. */
export function ChatPrimitivesShowcases() {
  return (
    <>
      <CollapsibleCardShowcase />
      <InteractiveCardShowcase />
      <OptionRowShowcase />

      <PlaygroundSection
        title="CompactPendingRow"
        description="Inline pending indicator for approval and question prompts."
      >
        <ShowcaseLabel>Approval type</ShowcaseLabel>
        <ShowcaseDemo>
          <CompactPendingRow type="approval" />
        </ShowcaseDemo>

        <ShowcaseLabel>Question type</ShowcaseLabel>
        <ShowcaseDemo>
          <CompactPendingRow type="question" />
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="CompactResultRow"
        description="Inline result row with icon, label, and optional trailing element."
      >
        <ShowcaseLabel>Approved</ShowcaseLabel>
        <ShowcaseDemo>
          <CompactResultRow
            icon={<Check className="size-3.5 text-emerald-500" />}
            label="Approved"
          />
        </ShowcaseDemo>

        <ShowcaseLabel>Denied</ShowcaseLabel>
        <ShowcaseDemo>
          <CompactResultRow icon={<X className="text-destructive size-3.5" />} label="Denied" />
        </ShowcaseDemo>

        <ShowcaseLabel>With trailing badge</ShowcaseLabel>
        <ShowcaseDemo>
          <CompactResultRow
            icon={<Check className="size-3.5 text-emerald-500" />}
            label="Approved"
            trailing={<Badge variant="secondary">auto</Badge>}
          />
        </ShowcaseDemo>
      </PlaygroundSection>
    </>
  );
}

function CollapsibleCardShowcase() {
  const [expanded, setExpanded] = useState(true);
  const [thinkingExpanded, setThinkingExpanded] = useState(false);

  return (
    <PlaygroundSection
      title="CollapsibleCard"
      description="Expandable card for tool calls and thinking blocks."
    >
      <ShowcaseLabel>Default (expanded)</ShowcaseLabel>
      <ShowcaseDemo>
        <CollapsibleCard
          expanded={expanded}
          onToggle={() => setExpanded((v) => !v)}
          header={<span className="text-sm font-medium">Read file — src/index.ts</span>}
        >
          <p className="text-muted-foreground text-sm">
            Card body content is visible when expanded.
          </p>
        </CollapsibleCard>
      </ShowcaseDemo>

      <ShowcaseLabel>Thinking variant</ShowcaseLabel>
      <ShowcaseDemo>
        <CollapsibleCard
          expanded={thinkingExpanded}
          onToggle={() => setThinkingExpanded((v) => !v)}
          header={<span className="text-sm font-medium">Thinking...</span>}
          variant="thinking"
        >
          <p className="text-muted-foreground text-sm">
            Extended thinking content rendered with thinking styling.
          </p>
        </CollapsibleCard>
      </ShowcaseDemo>

      <ShowcaseLabel>Disabled</ShowcaseLabel>
      <ShowcaseDemo>
        <CollapsibleCard
          expanded={false}
          onToggle={() => {}}
          header={<span className="text-sm font-medium">Disabled card</span>}
          disabled
        >
          <p className="text-muted-foreground text-sm">Cannot expand.</p>
        </CollapsibleCard>
      </ShowcaseDemo>

      <ShowcaseLabel>Hidden chevron with extra content</ShowcaseLabel>
      <ShowcaseDemo>
        <CollapsibleCard
          expanded
          onToggle={() => {}}
          header={<span className="text-sm font-medium">No chevron</span>}
          hideChevron
          extraContent={
            <p className="text-muted-foreground text-xs">Extra content slot below the body.</p>
          }
        >
          <p className="text-muted-foreground text-sm">Body content.</p>
        </CollapsibleCard>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

function InteractiveCardShowcase() {
  return (
    <PlaygroundSection
      title="InteractiveCard"
      description="Container with active/inactive/resolved visual states."
    >
      <ShowcaseLabel>Active</ShowcaseLabel>
      <ShowcaseDemo>
        <InteractiveCard isActive>
          <div className="flex items-center gap-2 p-3">
            <ShieldCheck className="text-primary size-4" />
            <span className="text-sm">Waiting for approval — active focus ring</span>
          </div>
        </InteractiveCard>
      </ShowcaseDemo>

      <ShowcaseLabel>Inactive (default)</ShowcaseLabel>
      <ShowcaseDemo>
        <InteractiveCard>
          <div className="flex items-center gap-2 p-3">
            <MessageCircleQuestion className="text-muted-foreground size-4" />
            <span className="text-muted-foreground text-sm">Inactive — dimmed appearance</span>
          </div>
        </InteractiveCard>
      </ShowcaseDemo>

      <ShowcaseLabel>Resolved</ShowcaseLabel>
      <ShowcaseDemo>
        <InteractiveCard isResolved>
          <div className="flex items-center gap-2 p-3">
            <Check className="size-4 text-emerald-500" />
            <span className="text-sm">Resolved — no dimming</span>
          </div>
        </InteractiveCard>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

function OptionRowShowcase() {
  const [selected, setSelected] = useState(0);

  return (
    <PlaygroundSection
      title="OptionRow"
      description="Selectable row with radio/checkbox control slot."
    >
      <ShowcaseDemo>
        <div className="space-y-1">
          {['Claude Opus', 'Claude Sonnet', 'Claude Haiku'].map((label, i) => (
            <OptionRow
              key={label}
              isSelected={selected === i}
              isFocused={selected === i}
              control={
                <div
                  className={`size-4 rounded-full border-2 ${
                    selected === i ? 'border-primary bg-primary' : 'border-muted-foreground/40'
                  }`}
                >
                  {selected === i && (
                    <div className="bg-primary-foreground m-auto mt-0.5 size-2 rounded-full" />
                  )}
                </div>
              }
            >
              <button
                type="button"
                onClick={() => setSelected(i)}
                className="w-full text-left text-sm"
              >
                {label}
              </button>
            </OptionRow>
          ))}
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
