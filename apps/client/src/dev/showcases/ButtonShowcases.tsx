import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import {
  Button,
  Badge,
  HoverBorderGradient,
  InlineCode,
  Kbd,
  PRESS_CARD,
  PRESS_MARK,
  PRESS_ROW,
} from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { Settings } from 'lucide-react';

/**
 * The three press stops, side by side and pressable.
 *
 * They are class strings rather than components, so the only honest way to show
 * them is to put one on each size of target and let a reviewer hold the mouse
 * down. Reading the numbers out of the source tells you nothing about whether
 * 0.94 on a 24px disc feels like the same press as 0.99 on a card.
 */
function PressLadderSection() {
  return (
    <PlaygroundSection
      title="Press ladder"
      description="Press scales by target size: 0.99 for a card, 0.98 for a row or chip, 0.94 for a mark. Hold the mouse down on each."
    >
      <ShowcaseLabel>PRESS_CARD — a whole tile is the target</ShowcaseLabel>
      <ShowcaseDemo>
        <button
          type="button"
          className={cn(
            'bg-card focus-ring hover:bg-accent w-full max-w-sm rounded-xl border p-4 text-left',
            PRESS_CARD
          )}
        >
          <p className="text-sm font-semibold">Scout</p>
          <p className="text-muted-foreground text-xs">Reviews pull requests</p>
        </button>
      </ShowcaseDemo>

      <ShowcaseLabel>PRESS_ROW — a row or a chip</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="w-full max-w-sm space-y-1">
          {['Standup notes', 'Release checklist'].map((label) => (
            <button
              key={label}
              type="button"
              className={cn(
                'focus-ring hover:bg-accent flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm',
                PRESS_ROW
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>PRESS_MARK — a disc or icon used as a button</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="flex items-center gap-2">
          {['🙂', '🎉', '🚀'].map((emoji) => (
            <button
              key={emoji}
              type="button"
              aria-label={`React with ${emoji}`}
              className={cn(
                'focus-ring bg-muted/60 hover:bg-accent flex size-11 items-center justify-center rounded-full border text-lg',
                PRESS_MARK
              )}
            >
              <span aria-hidden>{emoji}</span>
            </button>
          ))}
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/** Button, Badge, HoverBorderGradient, Kbd, and InlineCode component showcases. */
export function ButtonShowcases() {
  return (
    <>
      <PlaygroundSection
        title="Button"
        description="All variants, sizes, icon buttons, and disabled state."
      >
        <ShowcaseLabel>Variants</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="flex flex-wrap gap-2">
            <Button variant="default">Default</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="destructive">Destructive</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="brand">Brand</Button>
            <Button variant="link">Link</Button>
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>Sizes</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="xs">Extra Small</Button>
            <Button size="sm">Small</Button>
            <Button size="default">Default</Button>
            <Button size="lg">Large</Button>
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>Icon Buttons</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="icon-xs" aria-label="Settings">
              <Settings />
            </Button>
            <Button size="icon-sm" aria-label="Settings">
              <Settings />
            </Button>
            <Button size="icon" aria-label="Settings">
              <Settings />
            </Button>
            <Button size="icon-lg" aria-label="Settings">
              <Settings />
            </Button>
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>Disabled</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="flex flex-wrap gap-2">
            <Button disabled>Disabled</Button>
            <Button variant="secondary" disabled>
              Disabled
            </Button>
            <Button variant="outline" disabled>
              Disabled
            </Button>
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PressLadderSection />

      <PlaygroundSection
        title="Badge"
        description="Shape, fill, size, and status tone — four axes that compose."
      >
        <ShowcaseLabel>Variants</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="flex flex-wrap gap-2">
            <Badge variant="default">Default</Badge>
            <Badge variant="secondary">Secondary</Badge>
            <Badge variant="destructive">Destructive</Badge>
            <Badge variant="outline">Outline</Badge>
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>Sizes</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="flex flex-wrap items-center gap-2">
            <Badge size="sm">Small (default)</Badge>
            <Badge size="xs">Extra small</Badge>
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>Shapes — the pill four components used to redraw by hand</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="flex flex-wrap items-center gap-2">
            <Badge shape="default">Default</Badge>
            <Badge shape="pill">Pill</Badge>
            <Badge shape="pill" variant="outline">
              Pill outline
            </Badge>
            <Badge shape="pill" size="xs" variant="secondary">
              Pill xs
            </Badge>
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>Tones</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" tone="success">
              Success
            </Badge>
            <Badge variant="outline" tone="warning">
              Warning
            </Badge>
            <Badge variant="outline" tone="error">
              Error
            </Badge>
            <Badge variant="outline" tone="info">
              Info
            </Badge>
            <Badge variant="outline" tone="neutral">
              Neutral
            </Badge>
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>asChild — the badge IS the link</ShowcaseLabel>
        <ShowcaseDemo>
          <Badge asChild variant="secondary">
            <a href="#badge-aschild">Open the docs</a>
          </Badge>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="HoverBorderGradient"
        description="Animated gradient border button from Aceternity UI."
      >
        <ShowcaseDemo>
          <HoverBorderGradient>Get Started</HoverBorderGradient>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection title="Kbd" description="Keyboard shortcut hints.">
        <ShowcaseDemo>
          <div className="flex flex-wrap items-center gap-3">
            <Kbd>K</Kbd>
            <Kbd>
              <span>&#8984;</span>K
            </Kbd>
            <span className="text-muted-foreground text-xs">
              <Kbd>
                <span>&#8984;</span>Shift
              </Kbd>{' '}
              + <Kbd>P</Kbd>
            </span>
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="InlineCode"
        description="A command, path, or field name mentioned mid-sentence."
      >
        <ShowcaseDemo>
          <div className="max-w-sm space-y-2 text-sm">
            <p>
              Run <InlineCode>dorkos start</InlineCode> to launch the cockpit.
            </p>
            <p>
              Config lives at <InlineCode>~/.dork/config.json</InlineCode>, and a very long token
              like <InlineCode>npm i -g some-really-long-package-name-that-must-wrap</InlineCode>{' '}
              breaks mid-token instead of overflowing.
            </p>
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>
    </>
  );
}
