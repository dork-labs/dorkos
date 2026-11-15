import { useRef, useState } from 'react';
import { ArrowRight, Copy, Ellipsis, ExternalLink, KeyRound, X } from 'lucide-react';
import { useCopyFeedback } from '@/layers/shared/lib/use-copy-feedback';
import { cn } from '@/layers/shared/lib/utils';
import { useIsMobile, useMenuCloseFocusGuard } from '../../model';
import { Button } from '../button';
import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '../dropdown-menu';
import {
  ResponsiveDropdownMenu,
  ResponsiveDropdownMenuContent,
  ResponsiveDropdownMenuItem,
  ResponsiveDropdownMenuLabel,
  ResponsiveDropdownMenuRadioGroup,
  ResponsiveDropdownMenuRadioItem,
  ResponsiveDropdownMenuSeparator,
  ResponsiveDropdownMenuTrigger,
} from '../responsive-dropdown-menu';

/** Below this many pixels of chrome, Forward leaves the row for the menu. */
const NARROW_CHROME_PX = 480;

/** One page open in this chat, listed under Pages. */
export interface BrowserMenuPage {
  id: string;
  /** What the page calls itself; an empty title falls back to its host. */
  title: string;
  url: string;
}

/** Who has another chat's page right now. */
export type BrowserMenuChatStatus = 'agent' | 'you' | 'waiting';

/**
 * Another chat with a page open. It carries the chat's title, an address and a
 * status, and the menu shows only the address's site: another chat's page
 * title and full address are that chat's business, not this one's (DOR-4420
 * spec §10).
 */
export interface BrowserMenuOtherChat {
  sessionId: string;
  chatTitle: string;
  /** Any address on the site; only its host is shown. */
  address: string;
  status: BrowserMenuChatStatus;
}

/** Props for {@link BrowserMenu}. */
export interface BrowserMenuProps {
  /** The address open now. Copy and Open in your browser show only for a web page. */
  url: string;
  /** Pages open in this chat. The Pages group shows only with more than one. */
  pages?: BrowserMenuPage[];
  /** The page shown now, checked under Pages. */
  selectedPageId?: string | null;
  /** Show another of this chat's pages. */
  onSelectPage?: (id: string) => void;
  /** Whether there is a page to go forward to. */
  canForward?: boolean;
  /**
   * Go forward. The row hides Forward below 480px once a menu exists, so the
   * menu offers it there; with no handler the item stays, disabled.
   */
  onForward?: () => void;
  /** Open the address in the person's own browser. The item shows only with it. */
  onOpenExternally?: () => void;
  /** Other chats with a page open. The group shows only when there is one. */
  otherChats?: BrowserMenuOtherChat[];
  /** Go to another chat. */
  onOpenChat?: (sessionId: string) => void;
  /**
   * Ask to forget saved sign-ins, in a dialog the caller draws. The item shows
   * only with it. It gets the menu's button, for the dialog to hand focus back to.
   */
  onForgetSignIns?: (trigger: HTMLElement) => void;
  /** The closing item's words: Close browser, Close tab or Stop sharing. */
  closeLabel?: string;
  /**
   * Close. It gets the menu's button, which holds focus by then, so the caller
   * can put focus back somewhere sensible once the page is gone.
   */
  onClose?: (trigger: HTMLElement) => void;
  /** While another browser action runs, the items that change the browser wait. */
  busy?: boolean;
  /** Extra classes for the menu's button. */
  className?: string;
}

/** The site an address belongs to, or nothing when it is not a web address. */
function siteOf(address: string): string | null {
  try {
    const parsed = new URL(address);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed.host.replace(/^www\./, '');
  } catch {
    return null;
  }
}

const STATUS_WORDS: Record<BrowserMenuChatStatus, string> = {
  agent: 'Agent',
  you: 'You',
  waiting: 'Waiting',
};

/** "Shop · example.com · Agent": another chat's line, with nothing from its page. */
function chatLine(chat: BrowserMenuOtherChat): string {
  const site = siteOf(chat.address);
  return [site, STATUS_WORDS[chat.status]].filter(Boolean).join(' · ');
}

/**
 * The browser's ⋯ menu, at the end of the chrome: browser and page actions,
 * each group shown only when it applies. In order: Forward (only while the row
 * is too narrow to show it), Pages, Copy address, Open in your browser, Also
 * open in other chats, Forget saved sign-ins…, and the closing item (plain,
 * never red: closing loses nothing saved). A bottom sheet on a phone.
 *
 * Agent controls (Pause, Take over, Hand back) are the status pill's, not this
 * menu's. Its button names itself with the browser's own `title` hint, not a
 * Radix tooltip, because the Agent browser's native page hides under any Radix
 * popper; the open menu itself does hide that page, which is right while it
 * sits over it.
 */
export function BrowserMenu({
  url,
  pages = [],
  selectedPageId = null,
  onSelectPage,
  canForward = false,
  onForward,
  onOpenExternally,
  otherChats = [],
  onOpenChat,
  onForgetSignIns,
  closeLabel = 'Close browser',
  onClose,
  busy = false,
  className,
}: BrowserMenuProps) {
  const isMobile = useIsMobile();
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  // Measured as it opens: the menu draws outside the chrome, so the chrome's
  // own container query can't reach it.
  const [narrow, setNarrow] = useState(false);
  const { copy } = useCopyFeedback({ toastOnSettle: true });
  // Forget opens a dialog; the menu's own focus return would pull focus back out of it.
  const focusGuard = useMenuCloseFocusGuard();
  const web = siteOf(url) !== null;
  const showPages = pages.length > 1 && !!onSelectPage;
  const showChats = otherChats.length > 0;
  const chatsLabel = `Also open in ${otherChats.length} other ${otherChats.length === 1 ? 'chat' : 'chats'}`;

  const groups = [
    narrow && (
      <ResponsiveDropdownMenuItem
        key="forward"
        icon={ArrowRight}
        disabled={!onForward || !canForward}
        onSelect={() => onForward?.()}
      >
        Forward
      </ResponsiveDropdownMenuItem>
    ),
    showPages && (
      <div key="pages">
        <ResponsiveDropdownMenuLabel>Pages</ResponsiveDropdownMenuLabel>
        <ResponsiveDropdownMenuRadioGroup
          value={selectedPageId ?? ''}
          onValueChange={(id) => {
            if (id !== selectedPageId) onSelectPage?.(id);
          }}
        >
          {pages.map((page) => (
            <ResponsiveDropdownMenuRadioItem key={page.id} value={page.id} disabled={busy}>
              <span className="block max-w-64 truncate">{pageName(page)}</span>
            </ResponsiveDropdownMenuRadioItem>
          ))}
        </ResponsiveDropdownMenuRadioGroup>
      </div>
    ),
    web && (
      <div key="address">
        <ResponsiveDropdownMenuItem icon={Copy} onSelect={() => void copy(url)}>
          Copy address
        </ResponsiveDropdownMenuItem>
        {onOpenExternally && (
          <ResponsiveDropdownMenuItem icon={ExternalLink} onSelect={onOpenExternally}>
            Open in your browser
          </ResponsiveDropdownMenuItem>
        )}
      </div>
    ),
    showChats &&
      (isMobile ? (
        <div key="chats">
          <ResponsiveDropdownMenuLabel>{chatsLabel}</ResponsiveDropdownMenuLabel>
          {otherChats.map((chat) => (
            <ResponsiveDropdownMenuItem
              key={chat.sessionId}
              description={chatLine(chat)}
              onSelect={() => onOpenChat?.(chat.sessionId)}
            >
              {chat.chatTitle || 'Untitled chat'}
            </ResponsiveDropdownMenuItem>
          ))}
        </div>
      ) : (
        <DropdownMenuSub key="chats">
          <DropdownMenuSubTrigger>{chatsLabel}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="min-w-56">
            {otherChats.map((chat) => (
              <DropdownMenuItem
                key={chat.sessionId}
                onSelect={() => onOpenChat?.(chat.sessionId)}
                className="flex-col items-start gap-0"
              >
                <span className="max-w-64 truncate">{chat.chatTitle || 'Untitled chat'}</span>
                <span className="text-muted-foreground text-3xs">{chatLine(chat)}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      )),
    onForgetSignIns && (
      <ResponsiveDropdownMenuItem
        key="forget"
        icon={KeyRound}
        disabled={busy}
        onSelect={() => {
          if (!trigger.current) return;
          focusGuard.arm();
          onForgetSignIns(trigger.current);
        }}
      >
        Forget saved sign-ins…
      </ResponsiveDropdownMenuItem>
    ),
    onClose && (
      <ResponsiveDropdownMenuItem
        key="close"
        icon={X}
        disabled={busy}
        onSelect={() => {
          // The menu hands focus back to its button as it closes; take it there
          // first so the caller knows where the person was.
          const button = trigger.current;
          if (!button) return;
          button.focus();
          onClose(button);
        }}
      >
        {closeLabel}
      </ResponsiveDropdownMenuItem>
    ),
  ].filter(Boolean);
  // A menu with nothing in it is a dead button; Forward alone appears only once open.
  if (groups.length === 0 && !onForward) return null;

  return (
    <ResponsiveDropdownMenu
      open={open}
      onOpenChange={(next) => {
        if (next) {
          const chrome = trigger.current?.closest('[data-slot="browser-chrome"]');
          const width = chrome?.getBoundingClientRect().width ?? 0;
          setNarrow(isMobile || width < NARROW_CHROME_PX);
        }
        setOpen(next);
      }}
    >
      <ResponsiveDropdownMenuTrigger asChild>
        <Button
          ref={trigger}
          variant="ghost"
          size="icon-sm"
          aria-label="Browser menu"
          title="Browser menu"
          className={cn('text-muted-foreground hover:text-foreground md:size-7', className)}
        >
          <Ellipsis aria-hidden />
        </Button>
      </ResponsiveDropdownMenuTrigger>
      <ResponsiveDropdownMenuContent
        align="end"
        className="min-w-56"
        onCloseAutoFocus={focusGuard.onCloseAutoFocus}
      >
        {groups.flatMap((group, index) =>
          index === 0
            ? [group]
            : [<ResponsiveDropdownMenuSeparator key={`separator-${index}`} />, group]
        )}
      </ResponsiveDropdownMenuContent>
    </ResponsiveDropdownMenu>
  );
}

/** A page's name under Pages: its title, else its site, else "New page". */
function pageName(page: BrowserMenuPage): string {
  return page.title.trim() || siteOf(page.url) || 'New page';
}
