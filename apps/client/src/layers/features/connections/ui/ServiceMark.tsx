import { ADAPTER_LOGO_MAP } from '@dorkos/icons/adapter-logos';
import { cn } from '@/layers/shared/lib';

interface ServiceMarkProps {
  /** The catalog's icon key for the app. */
  iconKey: string;
  /** The app's name; its first letter is the fallback mark. */
  displayName: string;
  className?: string;
}

/**
 * The small square that identifies an app in the list. DorkOS's own chat apps
 * wear the marks the icon registry already carries; every other app gets a
 * neutral letter tile rather than a borrowed logo.
 */
export function ServiceMark({ iconKey, displayName, className }: ServiceMarkProps) {
  const Logo = ADAPTER_LOGO_MAP[iconKey.toLowerCase()];
  return (
    <span
      aria-hidden
      className={cn(
        'bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-md text-sm font-semibold',
        className
      )}
    >
      {Logo ? <Logo size={16} /> : displayName.trim().charAt(0).toUpperCase()}
    </span>
  );
}
