/**
 * The badge and chip system (Phase 2 Badge A): an inert label, a count, a pill
 * you can press, a pill you can dismiss, and the mention pills in a sentence.
 *
 * @module dev/showcases/BadgeChipShowcases
 */
import { useState } from 'react';
import { Filter, Sparkles } from 'lucide-react';
import { Badge, Chip, CountPill, MentionPill, RemovableChip } from '@/layers/shared/ui';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';

const ROW = 'flex flex-wrap items-center gap-2';

/** The grounds a badge or count has to read on. */
const GROUNDS = [
  { label: 'Page', className: 'bg-background' },
  { label: 'Card', className: 'bg-card' },
  { label: 'Sidebar', className: 'bg-sidebar' },
  { label: 'Selected row', className: 'bg-sidebar-accent' },
] as const;

function BadgeSection() {
  return (
    <PlaygroundSection
      title="Badge"
      description="An inert label. One 7% tint, a full radius, no border. Colour goes on the glyph and never the word, so every pairing clears AA on every ground."
    >
      <ShowcaseLabel>Tones — neutral, warning, error, success, live</ShowcaseLabel>
      <ShowcaseDemo>
        <div className={ROW}>
          <Badge>New</Badge>
          <Badge tone="warning">Waiting on you</Badge>
          <Badge tone="error">Failed</Badge>
          <Badge tone="success">Connected</Badge>
          <Badge live>3 live</Badge>
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Sizes — sm 12px, xs 11px</ShowcaseLabel>
      <ShowcaseDemo>
        <div className={ROW}>
          <Badge>Small</Badge>
          <Badge size="xs">Extra small</Badge>
          <Badge size="xs" tone="warning">
            Deprecated
          </Badge>
          <Badge size="xs" className="font-mono">
            v1.4.2
          </Badge>
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>On every ground</ShowcaseLabel>
      <div className="grid gap-2 sm:grid-cols-2">
        {GROUNDS.map((ground) => (
          <div key={ground.label} className={`${ground.className} rounded-lg p-3`}>
            <p className="text-muted-foreground mb-2 text-xs">{ground.label}</p>
            <div className={ROW}>
              <Badge>Installed</Badge>
              <Badge tone="warning">Not protected</Badge>
              <Badge tone="error">Not working</Badge>
              <CountPill count={3} label="3 mentions" />
            </div>
          </div>
        ))}
      </div>

      <ShowcaseLabel>Own glyph, or none; asChild</ShowcaseLabel>
      <ShowcaseDemo>
        <div className={ROW}>
          <Badge tone="success" icon={Sparkles}>
            Upgraded
          </Badge>
          <Badge tone="warning" icon={null}>
            No glyph
          </Badge>
          <Badge asChild>
            <a href="#badge">A link wearing the badge</a>
          </Badge>
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

function CountPillSection() {
  return (
    <PlaygroundSection
      title="Count pill"
      description="Who a count is for: orange means you (a mention, a DM), amber is waiting on a person, red failed, grey is activity. Inline caps at 99+, mentions and corners at 9+. A count never animates."
    >
      <ShowcaseLabel>Inline wash</ShowcaseLabel>
      <ShowcaseDemo>
        <div className={ROW}>
          <CountPill count={2} label="2 mentions" />
          <CountPill count={14} cap={9} label="More than 9 mentions" />
          <CountPill count={128} label="More than 99 new messages" />
          <CountPill count={4} tone="warning" label="4 waiting" />
          <CountPill count={1} tone="error" label="1 failed" />
          <CountPill count={7} tone="neutral" label="7 installed" />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Solid — over a glyph, or on a dark modal row</ShowcaseLabel>
      <ShowcaseDemo>
        <div className={ROW}>
          <CountPill solid count={2} label="2 mentions" />
          <CountPill solid count={4} tone="warning" label="4 waiting" />
          <CountPill solid count={1} tone="error" label="1 failed" />
          <CountPill solid count={7} tone="neutral" label="7" />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Corner — on a 28px control</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="flex items-center gap-6">
          {(
            [
              [3, 'warning'],
              [12, 'warning'],
              [2, 'neutral'],
            ] as const
          ).map(([count, tone]) => (
            <span
              key={`${count}-${tone}`}
              className="bg-foreground/7 relative inline-flex size-7 items-center justify-center rounded-md"
            >
              <Filter aria-hidden className="size-4" />
              <CountPill count={count} tone={tone} placement="corner" />
            </span>
          ))}
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

function ChipSection() {
  const [on, setOn] = useState<Record<string, boolean>>({ Failing: true });
  const [filters, setFilters] = useState(['Agent: Vela', 'Status: running', 'Project: lantern']);
  return (
    <PlaygroundSection
      title="Chip"
      description="A pill you can press. Rests on the badge tint, steps to 11% on hover, inverts when pressed. 24px on a desktop, 40 with a 44px hit area on a phone."
    >
      <ShowcaseLabel>Toggle (aria-pressed) — sm</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="flex flex-wrap items-center gap-1 max-md:gap-2">
          {['All', 'Running', 'Failing', 'Paused'].map((label) => (
            <Chip
              key={label}
              pressed={!!on[label]}
              onClick={() => setOn((all) => ({ ...all, [label]: !all[label] }))}
            >
              {label}
            </Chip>
          ))}
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Action — sm and md, with a glyph, disabled, long text</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="flex flex-wrap items-center gap-1 max-md:gap-2">
          <Chip icon={Sparkles}>Summarize this room</Chip>
          <Chip size="md" icon={Sparkles}>
            Draft a reply
          </Chip>
          <Chip disabled>Unavailable</Chip>
          <Chip title="A suggestion long enough that it has to truncate before the row ends">
            A suggestion long enough that it has to truncate before the row ends
          </Chip>
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>RemovableChip — focus moves to the neighbour on remove</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="flex flex-wrap items-center gap-1 max-md:gap-2">
          <div data-chip-group="" className="contents">
            {filters.map((filter) => (
              <RemovableChip
                key={filter}
                onRemove={() => setFilters((all) => all.filter((f) => f !== filter))}
                removeLabel={`Remove ${filter} filter`}
              >
                {filter}
              </RemovableChip>
            ))}
          </div>
          <Chip
            data-chip-group-add=""
            onClick={() => setFilters(['Agent: Vela', 'Status: running', 'Project: lantern'])}
          >
            Reset filters
          </Chip>
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

function MentionPillSection() {
  return (
    <PlaygroundSection
      title="Mention pill"
      description="Inline, so it wraps with the line. A person is a neutral pill on the chip tint; an agent wears its own colour; a cc says the word."
    >
      <ShowcaseLabel>In a sentence</ShowcaseLabel>
      <ShowcaseDemo>
        <p className="max-w-md text-sm leading-relaxed">
          <MentionPill kind="human" label="mara" handle="mara" resolved interactive tabIndex={0} />{' '}
          can you check the release notes with{' '}
          <MentionPill kind="agent" label="Vela" handle="vela" color="#6d5ae0" resolved />? Copying{' '}
          <MentionPill kind="human" label="tomas" handle="tomas" resolved cc /> and{' '}
          <MentionPill kind="agent" label="Orrin" handle="orrin" color="#0f8a6a" resolved cc /> so
          they see it.
        </p>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/** Badge, CountPill, Chip, RemovableChip and the mention pills. */
export function BadgeChipShowcases() {
  return (
    <>
      <BadgeSection />
      <CountPillSection />
      <ChipSection />
      <MentionPillSection />
    </>
  );
}
