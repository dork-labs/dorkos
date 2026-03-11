import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { Button, Badge, HoverBorderGradient, Kbd } from '@/layers/shared/ui';
import { Settings } from 'lucide-react';

/** Button, Badge, HoverBorderGradient, and Kbd component showcases. */
export function ButtonShowcases() {
  return (
    <>
      <PlaygroundSection
        title="Button"
        description="All variants, sizes, icon buttons, and disabled state."
      >
        <ShowcaseLabel>Variants</ShowcaseLabel>
        <div className="flex flex-wrap gap-2">
          <Button variant="default">Default</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="destructive">Destructive</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="brand">Brand</Button>
          <Button variant="link">Link</Button>
        </div>

        <ShowcaseLabel>Sizes</ShowcaseLabel>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="xs">Extra Small</Button>
          <Button size="sm">Small</Button>
          <Button size="default">Default</Button>
          <Button size="lg">Large</Button>
        </div>

        <ShowcaseLabel>Icon Buttons</ShowcaseLabel>
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

        <ShowcaseLabel>Disabled</ShowcaseLabel>
        <div className="flex flex-wrap gap-2">
          <Button disabled>Disabled</Button>
          <Button variant="secondary" disabled>
            Disabled
          </Button>
          <Button variant="outline" disabled>
            Disabled
          </Button>
        </div>
      </PlaygroundSection>

      <PlaygroundSection
        title="Badge"
        description="Label variants for status and categorization."
      >
        <div className="flex flex-wrap gap-2">
          <Badge variant="default">Default</Badge>
          <Badge variant="secondary">Secondary</Badge>
          <Badge variant="destructive">Destructive</Badge>
          <Badge variant="outline">Outline</Badge>
        </div>
      </PlaygroundSection>

      <PlaygroundSection
        title="HoverBorderGradient"
        description="Animated gradient border button from Aceternity UI."
      >
        <HoverBorderGradient>Get Started</HoverBorderGradient>
      </PlaygroundSection>

      <PlaygroundSection
        title="Kbd"
        description="Keyboard shortcut hints."
      >
        <div className="flex flex-wrap items-center gap-3">
          <Kbd>K</Kbd>
          <Kbd>
            <span>&#8984;</span>K
          </Kbd>
          <span className="text-muted-foreground text-xs">
            <Kbd>
              <span>&#8984;</span>Shift
            </Kbd>{' '}
            +{' '}
            <Kbd>P</Kbd>
          </span>
        </div>
      </PlaygroundSection>
    </>
  );
}
