/**
 * The shape every feature promo takes: a titled header, two things it can do,
 * and two buttons.
 *
 * All three promo dialogs were the identical thirty lines of markup with the
 * icons, one colour and the words swapped — three for three, in a directory
 * built to grow (DOR-1763 finding 17.6). A fourth promo now costs a data
 * literal instead of a fourth copy.
 *
 * @module features/feature-promos/ui/dialogs/PromoDialogLayout
 */
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';

/**
 * The three accent colours the promos spend, as flat tints.
 *
 * Flat, not gradients: `design-system.md` rules brand gradients out, and the
 * `from-X-500/10 → to-X-600/10` these used to carry was a gradient nobody could
 * see anyway.
 */
const TINTS = {
  indigo: { box: 'bg-indigo-500/10', icon: 'text-indigo-500' },
  purple: { box: 'bg-purple-500/10', icon: 'text-purple-500' },
  emerald: { box: 'bg-emerald-500/10', icon: 'text-emerald-500' },
} as const;

/** Which accent a promo wears. */
export type PromoTint = keyof typeof TINTS;

/** One thing the feature can do, as the promo lists it. */
export interface PromoHighlight {
  /** The glyph beside it. */
  icon: LucideIcon;
  /** What it is, in a few words. */
  title: string;
  /** What it does for you, in one line. */
  description: string;
}

/** A button in the promo's footer. */
export interface PromoDialogAction {
  /** What the button says. */
  label: string;
  /** What pressing it does. */
  onClick: () => void;
}

/** Everything a promo dialog renders. */
export interface PromoDialogLayoutProps {
  /** The feature's glyph, in the tinted box. */
  icon: LucideIcon;
  /** Which accent colour it wears. */
  tint: PromoTint;
  /** What the feature lets you do, as a headline. */
  title: string;
  /** The same thing in even fewer words, under the headline. */
  subtitle: string;
  /** Two things the feature can do. Keep it to two — this is a nudge, not a manual. */
  highlights: PromoHighlight[];
  /** The button that takes you there. */
  primaryAction: PromoDialogAction;
  /** The button that closes it. */
  secondaryAction: PromoDialogAction;
}

/**
 * Render a feature promo.
 *
 * @param icon - The feature's glyph.
 * @param tint - Which accent colour it wears.
 * @param title - What the feature lets you do.
 * @param subtitle - The same thing in fewer words.
 * @param highlights - Two things the feature can do.
 * @param primaryAction - The button that takes you there.
 * @param secondaryAction - The button that closes it.
 */
export function PromoDialogLayout({
  icon: Icon,
  tint,
  title,
  subtitle,
  highlights,
  primaryAction,
  secondaryAction,
}: PromoDialogLayoutProps) {
  const tone = TINTS[tint];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className={cn('flex size-10 items-center justify-center rounded-lg', tone.box)}>
          <Icon className={cn('size-5', tone.icon)} aria-hidden />
        </div>
        <div>
          <h3 className="text-sm font-medium">{title}</h3>
          <p className="text-muted-foreground text-xs">{subtitle}</p>
        </div>
      </div>

      <div className="bg-muted/50 space-y-3 rounded-lg p-4">
        {highlights.map(({ icon: HighlightIcon, title: name, description }) => (
          <div key={name} className="flex items-start gap-3">
            <HighlightIcon className="text-muted-foreground mt-0.5 size-4" aria-hidden />
            <div>
              <p className="text-xs font-medium">{name}</p>
              <p className="text-muted-foreground text-xs">{description}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={secondaryAction.onClick}>
          {secondaryAction.label}
        </Button>
        <Button size="sm" onClick={primaryAction.onClick}>
          {primaryAction.label}
        </Button>
      </div>
    </div>
  );
}
