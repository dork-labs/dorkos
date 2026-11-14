import { useCallback, useId, useRef, useState } from 'react';
import { sessionHref } from '@/layers/shared/lib';
import { useIsMobile } from '@/layers/shared/model';
import type { LocalBrowserPersonState } from '@dorkos/shared/local-browser';
import {
  Button,
  ResponsivePopover,
  ResponsivePopoverTrigger,
  ResponsivePopoverContent,
  ResponsivePopoverTitle,
} from '@/layers/shared/ui';

function tabHost(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return '';
  }
}

/** Person-only chat inventory. It contains origins, never other tabs' page titles or addresses. */
export function OpenChatTabs({
  tabs,
  label,
}: {
  tabs: NonNullable<LocalBrowserPersonState['openChatTabs']>;
  label?: string;
}) {
  const titleId = useId();
  const firstLink = useRef<HTMLAnchorElement>(null);
  const isMobile = useIsMobile();
  const [boundary, setBoundary] = useState<HTMLElement | null>(null);
  const findBoundary = useCallback((trigger: HTMLButtonElement | null) => {
    setBoundary(trigger?.closest<HTMLElement>('[data-slot="local-browser-panel"]') ?? null);
  }, []);
  return (
    // This is an explicitly opened sheet with no input; focus must enter its links.
    // eslint-disable-next-line jsx-a11y/no-autofocus
    <ResponsivePopover autoFocus>
      <ResponsivePopoverTrigger asChild>
        <Button
          ref={findBoundary}
          variant="ghost"
          size="sm"
          aria-haspopup="dialog"
          className="-ms-3 h-auto min-h-11 py-2 text-left whitespace-normal md:h-auto"
        >
          {label ?? `Also open in ${tabs.length} other ${tabs.length === 1 ? 'chat' : 'chats'}`}
        </Button>
      </ResponsivePopoverTrigger>
      <ResponsivePopoverContent
        aria-label="Open chat tabs"
        aria-describedby={undefined}
        side="bottom"
        align="start"
        className="max-h-[min(70vh,600px,var(--radix-popover-content-available-height))] max-w-(--radix-popover-content-available-width) space-y-3"
        {...(!isMobile ? { collisionBoundary: boundary } : {})}
        onOpenAutoFocus={(event) => {
          if (!firstLink.current) return;
          event.preventDefault();
          firstLink.current.focus();
        }}
      >
        <ResponsivePopoverTitle id={titleId}>Open chat tabs</ResponsivePopoverTitle>
        <ul className="space-y-3">
          {tabs.map((tab, index) => (
            <li key={tab.sessionId}>
              <a
                ref={index === 0 ? firstLink : undefined}
                className="focus-visible:ring-ring block min-h-11 rounded p-2 break-words focus-visible:ring-2"
                href={sessionHref({ session: tab.sessionId })}
              >
                <span className="block text-sm font-medium">{tab.title}</span>
                <span className="text-muted-foreground block text-xs">
                  {[tabHost(tab.origin), tab.state].filter(Boolean).join(' · ')}
                </span>
              </a>
            </li>
          ))}
        </ul>
      </ResponsivePopoverContent>
    </ResponsivePopover>
  );
}
