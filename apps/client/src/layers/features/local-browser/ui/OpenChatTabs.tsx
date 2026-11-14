import { useId } from 'react';
import { sessionHref } from '@/layers/shared/lib';
import type { LocalBrowserPersonState } from '@dorkos/shared/local-browser';
import {
  Button,
  ResponsivePopover,
  ResponsivePopoverTrigger,
  ResponsivePopoverContent,
  ResponsivePopoverTitle,
} from '@/layers/shared/ui';

/** Person-only chat inventory. It contains origins, never other tabs' page titles or addresses. */
export function OpenChatTabs({
  tabs,
  label,
}: {
  tabs: NonNullable<LocalBrowserPersonState['openChatTabs']>;
  label?: string;
}) {
  const titleId = useId();
  return (
    // This is an explicitly opened sheet with no input; focus must enter its links.
    // eslint-disable-next-line jsx-a11y/no-autofocus
    <ResponsivePopover autoFocus>
      <ResponsivePopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-haspopup="dialog"
          className="h-auto min-h-11 text-left whitespace-normal"
        >
          {label ?? `Also open in ${tabs.length} other ${tabs.length === 1 ? 'chat' : 'chats'}`}
        </Button>
      </ResponsivePopoverTrigger>
      <ResponsivePopoverContent
        aria-label="Open chat tabs"
        aria-describedby={undefined}
        className="space-y-3"
      >
        <ResponsivePopoverTitle id={titleId}>Open chat tabs</ResponsivePopoverTitle>
        <ul className="space-y-3">
          {tabs.map((tab) => (
            <li key={tab.sessionId}>
              <a
                className="focus-visible:ring-ring block min-h-11 rounded p-2 break-words focus-visible:ring-2"
                href={sessionHref({ session: tab.sessionId })}
              >
                <span className="block text-sm font-medium">{tab.title}</span>
                <span className="text-muted-foreground block text-xs">
                  {tab.origin} · {tab.state}
                </span>
              </a>
            </li>
          ))}
        </ul>
      </ResponsivePopoverContent>
    </ResponsivePopover>
  );
}
