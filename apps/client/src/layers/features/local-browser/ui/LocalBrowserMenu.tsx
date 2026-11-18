import { useRef, useState } from 'react';
import type { LocalBrowserState } from '@dorkos/shared/local-browser';
import { openExternalLink } from '@/layers/shared/lib';
import { useTransport } from '@/layers/shared/model';
import { BrowserMenu } from '@/layers/shared/ui';
import { ForgetSignInsDialog } from './ForgetSignInsDialog';

/** Props for {@link LocalBrowserMenu}. */
export interface LocalBrowserMenuProps {
  /** The connected browser, shared with this chat or with nobody. */
  state: LocalBrowserState;
  /** Whether another browser action is running. */
  busy: boolean;
  /** Run a browser action through the panel, which owns busy and error. */
  action: (run: () => Promise<LocalBrowserState>) => Promise<boolean>;
  /** Whether saved sign-ins can be read, so Forget can be offered. */
  canForgetSignIns: boolean;
  /** Close the browser, with the menu's button for focus to return from. */
  onClose: (trigger: HTMLElement) => void;
  /** Whether the page can go forward; the same as the row's Forward. */
  canForward?: boolean;
  /** Go forward, offered here while the row is too narrow to show Forward. */
  onForward?: () => void;
}

/**
 * The Agent browser's ⋯ menu (DOR-4429): its pages, the address, Forget saved
 * sign-ins and Close browser. It replaces the tab picker, the Disconnect button
 * and the Saved sign-ins row that sat above the page.
 *
 * Close says "Close browser" in both modes, because it closes the whole
 * browser, own window included. Forward takes the row's own handler and
 * state (DOR-4449), so it works the same while the row is too narrow to show
 * it. "Also open in other chats" waits on
 * the server listing other chats' pages, so it never shows yet.
 */
export function LocalBrowserMenu({
  state,
  busy,
  action,
  canForgetSignIns,
  onClose,
  canForward = false,
  onForward,
}: LocalBrowserMenuProps) {
  const transport = useTransport();
  const [asking, setAsking] = useState(false);
  const [notice, setNotice] = useState('');
  const opener = useRef<HTMLElement | null>(null);
  const selected = state.tabs.find((tab) => tab.id === state.selectedTabId);
  return (
    <>
      <BrowserMenu
        url={selected?.url ?? ''}
        pages={state.tabs}
        selectedPageId={state.selectedTabId}
        onSelectPage={(id) => void action(() => transport.selectLocalBrowserTab(id))}
        onOpenExternally={selected ? () => openExternalLink(selected.url) : undefined}
        // The plain window opens on the site's origin, never the page's own path (DOR-4097).
        onSignInSeparately={
          selected
            ? () =>
                void action(() =>
                  transport.signInLocalBrowser({ url: new URL(selected.url).origin })
                )
            : undefined
        }
        onForgetSignIns={
          canForgetSignIns
            ? (trigger) => {
                opener.current = trigger;
                setNotice('');
                setAsking(true);
              }
            : undefined
        }
        onClose={onClose}
        canForward={canForward}
        onForward={onForward}
        busy={busy}
      />
      <p role="status" className="sr-only">
        {notice}
      </p>
      <ForgetSignInsDialog
        open={asking}
        onOpenChange={setAsking}
        returnFocus={opener}
        onForgotten={() => setNotice('Sign-ins forgotten.')}
      />
    </>
  );
}
