import { useState } from 'react';
import { ADAPTER_LOGO_MAP } from '@dorkos/icons/adapter-logos';
import { APP_LOGO_MAP } from '@dorkos/icons/app-logos';
import { cn } from '@/layers/shared/lib';

interface ServiceMarkProps {
  /** The catalog's icon key for the app (its service id). */
  iconKey: string;
  /** The app's name; its first letter is the fallback mark. */
  displayName: string;
  /**
   * The catalog's same-origin logo path for the app, when a connection service
   * sent one. Never a third-party URL: the server fetches and serves it.
   */
  logo?: string;
  className?: string;
}

/**
 * The small square that identifies an app. In order: the app's own mark as it
 * ships with DorkOS, then the logo the server kept from the app's connection
 * service, then the chat-app glyph, then the first letter of its name.
 *
 * A real logo sits on a white tile in light and dark mode alike, so a black
 * mark (GitHub, Notion) never disappears. A logo that fails to load falls back
 * to the letter tile, never a broken-image icon.
 */
export function ServiceMark({ iconKey, displayName, logo, className }: ServiceMarkProps) {
  const key = iconKey.toLowerCase();
  const src = APP_LOGO_MAP[key] ?? logo;
  // The source that failed to load; a new source gets its own try.
  const [failed, setFailed] = useState<string | null>(null);
  const tile = 'flex size-8 shrink-0 items-center justify-center rounded-md';

  if (src && failed !== src) {
    return (
      <span
        aria-hidden
        data-slot="service-logo"
        className={cn(tile, 'bg-white ring-1 ring-black/10 ring-inset', className)}
      >
        <img
          src={src}
          alt=""
          draggable={false}
          onError={() => setFailed(src)}
          className="size-[62%] object-contain"
        />
      </span>
    );
  }

  const Glyph = ADAPTER_LOGO_MAP[key];
  return (
    <span
      aria-hidden
      className={cn(tile, 'bg-muted text-muted-foreground text-sm font-semibold', className)}
    >
      {Glyph ? <Glyph size={16} /> : displayName.trim().charAt(0).toUpperCase()}
    </span>
  );
}
