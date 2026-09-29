import { useState } from 'react';
import { ADAPTER_LOGO_MAP } from '@dorkos/icons/adapter-logos';
import { APP_LOGO_MAP } from '@dorkos/icons/app-logos';
import { connectorCatalogLogoPath } from '@dorkos/shared/connector-resource-schemas';
import { cn } from '@/layers/shared/lib';
import type { ServiceLogo } from '../lib/service-logo';

interface ServiceMarkProps {
  /** The catalog's icon key for the app (its service id). */
  iconKey: string;
  /** The app's name; its first letter is the fallback mark. */
  displayName: string;
  /**
   * What the catalog says about the app's logo (see {@link ServiceLogo}): its
   * same-origin path, `null` when the catalog lists the app with no logo (then
   * nothing is requested), or `undefined` when the caller has no catalog entry
   * (then the mark asks the server route by service id, so an app off the
   * loaded catalog pages still gets its logo). Never a third-party URL.
   */
  logo?: ServiceLogo;
  className?: string;
}

/**
 * The small square that identifies an app. In order: the app's own mark as it
 * ships with DorkOS, then the catalog's logo, then the chat-app glyph, then the
 * server's logo route asked by service id (it answers 404 for an app with no
 * logo), then the first letter of its name.
 *
 * A real logo sits on a white tile in light and dark mode alike, so a black
 * mark (GitHub, Notion) never disappears. A logo that fails to load falls back
 * to the letter tile, never a broken-image icon.
 */
export function ServiceMark({ iconKey, displayName, logo, className }: ServiceMarkProps) {
  const key = iconKey.toLowerCase();
  const Glyph = ADAPTER_LOGO_MAP[key];
  const derived = logo === undefined && !Glyph ? connectorCatalogLogoPath(iconKey) : undefined;
  const src = APP_LOGO_MAP[key] ?? logo ?? derived;
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

  return (
    <span
      aria-hidden
      className={cn(tile, 'bg-muted text-muted-foreground text-sm font-semibold', className)}
    >
      {Glyph ? <Glyph size={16} /> : displayName.trim().charAt(0).toUpperCase()}
    </span>
  );
}
