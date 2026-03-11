import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { Button } from '@/layers/shared/ui';
import { Settings } from 'lucide-react';

interface ColorToken {
  name: string;
  bg: string;
  border?: boolean;
}

const SEMANTIC_COLORS: ColorToken[] = [
  { name: 'background', bg: 'bg-background', border: true },
  { name: 'foreground', bg: 'bg-foreground' },
  { name: 'card', bg: 'bg-card', border: true },
  { name: 'popover', bg: 'bg-popover', border: true },
  { name: 'primary', bg: 'bg-primary' },
  { name: 'secondary', bg: 'bg-secondary', border: true },
  { name: 'muted', bg: 'bg-muted', border: true },
  { name: 'accent', bg: 'bg-accent', border: true },
  { name: 'destructive', bg: 'bg-destructive' },
  { name: 'border', bg: 'bg-border' },
  { name: 'input', bg: 'bg-input' },
  { name: 'ring', bg: 'bg-ring' },
  { name: 'brand', bg: 'bg-brand' },
  { name: 'user-msg', bg: 'bg-user-msg' },
  { name: 'surface', bg: 'bg-surface', border: true },
];

const SIDEBAR_COLORS: ColorToken[] = [
  { name: 'sidebar', bg: 'bg-sidebar', border: true },
  { name: 'sidebar-foreground', bg: 'bg-sidebar-foreground' },
  { name: 'sidebar-primary', bg: 'bg-sidebar-primary' },
  { name: 'sidebar-accent', bg: 'bg-sidebar-accent', border: true },
  { name: 'sidebar-border', bg: 'bg-sidebar-border' },
  { name: 'sidebar-ring', bg: 'bg-sidebar-ring' },
];

const STATUS_ROWS = [
  {
    name: 'success',
    base: 'bg-status-success',
    bg: 'bg-status-success-bg',
    borderCls: 'border-status-success-border',
    fg: 'text-status-success-fg',
  },
  {
    name: 'error',
    base: 'bg-status-error',
    bg: 'bg-status-error-bg',
    borderCls: 'border-status-error-border',
    fg: 'text-status-error-fg',
  },
  {
    name: 'warning',
    base: 'bg-status-warning',
    bg: 'bg-status-warning-bg',
    borderCls: 'border-status-warning-border',
    fg: 'text-status-warning-fg',
  },
  {
    name: 'info',
    base: 'bg-status-info',
    bg: 'bg-status-info-bg',
    borderCls: 'border-status-info-border',
    fg: 'text-status-info-fg',
  },
  {
    name: 'pending',
    base: 'bg-status-pending',
    bg: 'bg-status-pending-bg',
    borderCls: '',
    fg: 'text-status-pending-fg',
  },
] as const;

const TYPE_SCALE = [
  { cls: 'text-3xs', label: 'text-3xs', px: '10px' },
  { cls: 'text-2xs', label: 'text-2xs', px: '11px' },
  { cls: 'text-xs', label: 'text-xs', px: '12px' },
  { cls: 'text-sm', label: 'text-sm', px: '14px' },
  { cls: 'text-base', label: 'text-base', px: '16px' },
  { cls: 'text-lg', label: 'text-lg', px: '18px' },
  { cls: 'text-xl', label: 'text-xl', px: '20px' },
] as const;

const SPACING = [
  { key: '1', px: '4px', hint: 'p-1 / gap-1' },
  { key: '2', px: '8px', hint: 'p-2 / gap-2' },
  { key: '3', px: '12px', hint: 'p-3 / gap-3' },
  { key: '4', px: '16px', hint: 'p-4 / gap-4' },
  { key: '6', px: '24px', hint: 'p-6 / gap-6' },
  { key: '8', px: '32px', hint: 'p-8 / gap-8' },
  { key: '12', px: '48px', hint: 'p-12 / gap-12' },
] as const;

const RADII = [
  { cls: 'rounded-sm', label: 'rounded-sm' },
  { cls: 'rounded-md', label: 'rounded-md' },
  { cls: 'rounded-lg', label: 'rounded-lg' },
  { cls: 'rounded-xl', label: 'rounded-xl' },
] as const;

const SHADOWS = [
  { cls: 'shadow-sm', label: 'shadow-sm' },
  { cls: 'shadow', label: 'shadow' },
  { cls: 'shadow-md', label: 'shadow-md' },
  { cls: 'shadow-lg', label: 'shadow-lg' },
  { cls: 'shadow-xl', label: 'shadow-xl' },
] as const;

/** Design tokens reference page — colors, typography, spacing, radii, shadows. */
export function TokensPage() {
  return (
    <>
      <header className="border-border border-b px-6 py-4">
        <h1 className="text-xl font-bold">Design Tokens</h1>
        <p className="text-muted-foreground text-sm">
          Visual reference for the design system's color, type, spacing, and shape tokens.
        </p>
      </header>

      <main className="mx-auto max-w-4xl space-y-8 p-6">
        <SemanticColorsSection />
        <StatusColorsSection />
        <SidebarColorsSection />
        <TypographySection />
        <SpacingSection />
        <RadiiSection />
        <ShadowsSection />
        <SizesSection />
      </main>
    </>
  );
}

function ColorSwatch({ name, bg, border }: { name: string; bg: string; border?: boolean }) {
  return (
    <div className="space-y-1.5">
      <div
        className={`h-16 rounded-lg ${bg} ${border ? 'border border-border' : ''}`}
      />
      <p className="text-foreground text-xs font-medium">{name}</p>
      <p className="text-muted-foreground font-mono text-3xs">--{name}</p>
    </div>
  );
}

function SemanticColorsSection() {
  return (
    <PlaygroundSection title="Semantic Colors" description="Core palette tokens used throughout the UI.">
      <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 lg:grid-cols-5">
        {SEMANTIC_COLORS.map((c) => (
          <ColorSwatch key={c.name} name={c.name} bg={c.bg} border={c.border} />
        ))}
      </div>
    </PlaygroundSection>
  );
}

function StatusColorsSection() {
  return (
    <PlaygroundSection title="Status Colors" description="Semantic status tokens with base, background, border, and foreground variants.">
      <div className="space-y-3">
        {STATUS_ROWS.map((status) => (
          <div key={status.name} className="flex items-center gap-3">
            <span className="text-foreground w-16 text-xs font-medium">{status.name}</span>
            <div className="flex gap-2">
              <div
                className={`h-10 w-10 rounded-md ${status.base}`}
                title={`status-${status.name}`}
              />
              <div
                className={`h-10 w-10 rounded-md border ${status.bg} ${status.borderCls}`}
                title={`status-${status.name}-bg`}
              />
              <div
                className={`flex h-10 items-center rounded-md px-2 text-xs font-medium ${status.fg} ${status.bg}`}
                title={`status-${status.name}-fg`}
              >
                Text
              </div>
            </div>
          </div>
        ))}
      </div>
    </PlaygroundSection>
  );
}

function SidebarColorsSection() {
  return (
    <PlaygroundSection title="Sidebar Colors" description="Tokens specific to the sidebar component.">
      <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 lg:grid-cols-5">
        {SIDEBAR_COLORS.map((c) => (
          <ColorSwatch key={c.name} name={c.name} bg={c.bg} border={c.border} />
        ))}
      </div>
    </PlaygroundSection>
  );
}

function TypographySection() {
  return (
    <PlaygroundSection title="Typography" description="Type scale, weights, and font families.">
      <ShowcaseLabel>Type Scale</ShowcaseLabel>
      <div className="space-y-3">
        {TYPE_SCALE.map((t) => (
          <div key={t.cls} className="flex items-baseline gap-4">
            <span className="text-muted-foreground w-20 shrink-0 font-mono text-3xs">{t.label}</span>
            <span className="text-muted-foreground w-10 shrink-0 font-mono text-3xs">{t.px}</span>
            <span className={`text-foreground ${t.cls}`}>The quick brown fox</span>
          </div>
        ))}
      </div>

      <ShowcaseLabel>Font Weights</ShowcaseLabel>
      <div className="flex gap-8">
        <span className="text-foreground text-sm font-normal">Normal (400)</span>
        <span className="text-foreground text-sm font-medium">Medium (500)</span>
        <span className="text-foreground text-sm font-semibold">Semibold (600)</span>
      </div>

      <ShowcaseLabel>Font Families</ShowcaseLabel>
      <div className="space-y-2">
        <p className="text-foreground text-sm font-sans">Sans: The quick brown fox jumps over the lazy dog</p>
        <p className="text-foreground text-sm font-mono">Mono: The quick brown fox jumps over the lazy dog</p>
      </div>
    </PlaygroundSection>
  );
}

function SpacingSection() {
  return (
    <PlaygroundSection title="Spacing" description="8pt grid spacing scale.">
      <div className="space-y-3">
        {SPACING.map((s) => (
          <div key={s.key} className="flex items-center gap-4">
            <span className="text-muted-foreground w-24 shrink-0 font-mono text-3xs">
              space-{s.key} &middot; {s.px}
            </span>
            <div
              className="bg-primary h-3 rounded-sm"
              style={{ width: s.px }}
            />
            <span className="text-muted-foreground text-3xs">{s.hint}</span>
          </div>
        ))}
      </div>
    </PlaygroundSection>
  );
}

function RadiiSection() {
  return (
    <PlaygroundSection title="Border Radius" description="Standard radii plus message-specific tokens.">
      <div className="flex flex-wrap gap-4">
        {RADII.map((r) => (
          <div key={r.cls} className="space-y-1.5 text-center">
            <div className={`border-border bg-muted h-16 w-16 border-2 ${r.cls}`} />
            <p className="text-muted-foreground font-mono text-3xs">{r.label}</p>
          </div>
        ))}
        <div className="space-y-1.5 text-center">
          <div
            className="border-border bg-muted h-16 w-16 border-2"
            style={{ borderRadius: 'var(--radius-msg)' }}
          />
          <p className="text-muted-foreground font-mono text-3xs">radius-msg</p>
          <p className="text-muted-foreground text-3xs">20px</p>
        </div>
        <div className="space-y-1.5 text-center">
          <div
            className="border-border bg-muted h-16 w-16 border-2"
            style={{ borderRadius: 'var(--radius-msg-tight)' }}
          />
          <p className="text-muted-foreground font-mono text-3xs">radius-msg-tight</p>
          <p className="text-muted-foreground text-3xs">4px</p>
        </div>
      </div>
    </PlaygroundSection>
  );
}

function ShadowsSection() {
  return (
    <PlaygroundSection title="Shadows" description="Standard Tailwind shadow scale.">
      <div className="flex flex-wrap gap-4">
        {SHADOWS.map((s) => (
          <div key={s.cls} className="space-y-1.5 text-center">
            <div className={`bg-card h-16 w-24 rounded-lg border ${s.cls}`} />
            <p className="text-muted-foreground font-mono text-3xs">{s.label}</p>
          </div>
        ))}
      </div>
    </PlaygroundSection>
  );
}

function SizesSection() {
  return (
    <PlaygroundSection title="Icon & Button Sizes" description="Standard size tokens for icons and interactive elements.">
      <ShowcaseLabel>Icon Sizes</ShowcaseLabel>
      <div className="flex items-end gap-6">
        {[
          { label: 'icon-xs', cls: 'size-[var(--size-icon-xs)]' },
          { label: 'icon-sm', cls: 'size-[var(--size-icon-sm)]' },
          { label: 'icon-md', cls: 'size-[var(--size-icon-md)]' },
        ].map((icon) => (
          <div key={icon.label} className="space-y-1.5 text-center">
            <Settings className={`text-foreground ${icon.cls}`} />
            <p className="text-muted-foreground font-mono text-3xs">{icon.label}</p>
          </div>
        ))}
      </div>

      <ShowcaseLabel>Button Heights</ShowcaseLabel>
      <div className="flex items-end gap-4">
        <div className="space-y-1.5 text-center">
          <Button size="sm">Small</Button>
          <p className="text-muted-foreground font-mono text-3xs">btn-sm</p>
        </div>
        <div className="space-y-1.5 text-center">
          <Button size="default">Default</Button>
          <p className="text-muted-foreground font-mono text-3xs">btn-md</p>
        </div>
        <div className="space-y-1.5 text-center">
          <Button size="lg">Large</Button>
          <p className="text-muted-foreground font-mono text-3xs">btn-lg</p>
        </div>
      </div>
    </PlaygroundSection>
  );
}
