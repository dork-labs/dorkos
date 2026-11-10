import { cn } from '@/layers/shared/lib';
import { APP_NEEDS_UPDATE_COPY } from '../lib/needs-update-copy';

/** Props for {@link AppNeedsUpdateNotice}. */
export interface AppNeedsUpdateNoticeProps {
  /** The app's name, as the person reads it. */
  name: string;
  /** Extra classes for the wrapper, for the surface's own spacing. */
  className?: string;
}

/**
 * An app that was built for an older version of DorkOS and runs nothing until
 * it is rebuilt. Neutral, never an error: nothing broke, the app is out of date.
 *
 * @param props - The app's name and the wrapper's classes.
 */
export function AppNeedsUpdateNotice({ name, className }: AppNeedsUpdateNoticeProps) {
  return (
    <div data-testid="app-needs-update" className={cn('flex flex-col gap-1', className)}>
      <p className="text-foreground text-sm font-medium">{APP_NEEDS_UPDATE_COPY.headline(name)}</p>
      <p className="text-muted-foreground text-sm">{APP_NEEDS_UPDATE_COPY.detail}</p>
    </div>
  );
}
