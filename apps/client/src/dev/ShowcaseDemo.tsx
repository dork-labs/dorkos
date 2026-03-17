import { useState } from 'react';
import { Monitor, Tablet, Smartphone } from 'lucide-react';
import { cn } from '@/layers/shared/lib';

type Viewport = 'full' | 'tablet' | 'mobile';

const VIEWPORTS: { value: Viewport; icon: React.ComponentType<{ className?: string }>; maxWidth: string | undefined; label: string }[] = [
  { value: 'full', icon: Monitor, maxWidth: undefined, label: 'Desktop' },
  { value: 'tablet', icon: Tablet, maxWidth: '768px', label: 'Tablet (768px)' },
  { value: 'mobile', icon: Smartphone, maxWidth: '375px', label: 'Mobile (375px)' },
];

interface ShowcaseDemoProps {
  children: React.ReactNode;
  className?: string;
  /** When true, shows a viewport-size toolbar to preview the demo at different widths. */
  responsive?: boolean;
}

/** Subtle inset wrapper that visually separates a component demo from its surrounding documentation. */
export function ShowcaseDemo({ children, className, responsive }: ShowcaseDemoProps) {
  const [viewport, setViewport] = useState<Viewport>('full');
  const activeMaxWidth = VIEWPORTS.find((v) => v.value === viewport)?.maxWidth;

  return (
    <div className={cn('rounded-lg border border-dashed border-border/50 bg-muted/30 p-4', className)}>
      {responsive && (
        <div className="mb-3 flex gap-1">
          {VIEWPORTS.map(({ value, icon: Icon, label }) => (
            <button
              key={value}
              type="button"
              onClick={() => setViewport(value)}
              className={cn(
                'rounded-md p-1.5 transition-colors',
                viewport === value
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:text-foreground',
              )}
              aria-label={label}
              title={label}
            >
              <Icon className="size-3.5" />
            </button>
          ))}
        </div>
      )}
      <div
        className="transition-[max-width] duration-200"
        style={activeMaxWidth ? { maxWidth: activeMaxWidth } : undefined}
      >
        {children}
      </div>
    </div>
  );
}
