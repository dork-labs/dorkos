// @vitest-environment jsdom
/**
 * The browser's ⋯ menu, on the real Radix dropdown (desktop) and the real
 * drawer (phone): no stand-ins, so what these cases see is what ships.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { BrowserMenu, type BrowserMenuOtherChat, type BrowserMenuProps } from '../browser-chrome';

/** Whether the window reads as a phone: the real `useIsMobile` asks `matchMedia`. */
let phone = false;

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: phone && query.includes('max-width'),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
});
beforeEach(() => {
  phone = false;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Made-up chats; each address carries a path, a query and a fragment the menu must drop. */
const OTHER_CHATS: BrowserMenuOtherChat[] = [
  {
    sessionId: 'chat-a',
    chatTitle: 'Book the venue',
    address: 'https://www.northwind.example/admin/bookings?guest=ada#row-4',
    status: 'agent',
  },
  {
    sessionId: 'chat-b',
    chatTitle: 'Pay the March invoices',
    address: 'https://billing.example/invoices/77?token=secret-token',
    status: 'waiting',
  },
];

/** Draw the menu inside a chrome of a given width, as the Agent browser does. */
function mount(props: Partial<BrowserMenuProps> = {}, chromeWidth = 640) {
  const view = render(
    <div data-slot="browser-chrome">
      <BrowserMenu url="https://northwind.example/pricing" onClose={() => {}} {...props} />
    </div>
  );
  const chrome = view.container.querySelector<HTMLElement>('[data-slot="browser-chrome"]')!;
  vi.spyOn(chrome, 'getBoundingClientRect').mockReturnValue({ width: chromeWidth } as DOMRect);
  return view;
}

/** Open the menu from the keyboard, as Radix expects in jsdom. */
function openMenu(): HTMLElement {
  const trigger = screen.getByRole('button', { name: 'Browser menu' });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'Enter' });
  return screen.getByRole('menu');
}

describe('BrowserMenu', () => {
  describe('other chats’ pages (DOR-4420 §10)', () => {
    it('shows each chat’s title, site and status, never its page title or address', () => {
      const onOpenChat = vi.fn();
      mount({ otherChats: OTHER_CHATS, onOpenChat });
      const menu = openMenu();
      const trigger = within(menu).getByRole('menuitem', { name: 'Also open in 2 other chats' });
      trigger.focus();
      fireEvent.keyDown(trigger, { key: 'ArrowRight' });
      const sub = screen.getAllByRole('menu').at(-1)!;
      const venue = within(sub).getByRole('menuitem', { name: /Book the venue/ });
      expect(venue).toHaveTextContent('Book the venuenorthwind.example · Agent');
      expect(within(sub).getByRole('menuitem', { name: /March invoices/ })).toHaveTextContent(
        'billing.example · Waiting'
      );
      for (const leak of ['/admin', 'guest=ada', '#row-4', '/invoices', 'secret-token', 'www.'])
        expect(document.body).not.toHaveTextContent(leak);
      fireEvent.click(venue);
      expect(onOpenChat).toHaveBeenCalledExactlyOnceWith('chat-a');
    });
    it('on a phone, lists them in the sheet with the same three things only', () => {
      phone = true;
      mount({ otherChats: OTHER_CHATS });
      fireEvent.click(screen.getByRole('button', { name: 'Browser menu' }));
      const sheet = screen.getByRole('dialog');
      expect(within(sheet).getByText('Also open in 2 other chats')).toBeInTheDocument();
      expect(within(sheet).getByRole('button', { name: /Book the venue/ })).toHaveTextContent(
        'northwind.example · Agent'
      );
      for (const leak of ['/admin', 'guest=ada', '/invoices', 'secret-token'])
        expect(sheet).not.toHaveTextContent(leak);
    });
    it('says "chat" for one, and shows no group with none', () => {
      mount({ otherChats: [OTHER_CHATS[0]!] });
      expect(
        within(openMenu()).getByRole('menuitem', { name: 'Also open in 1 other chat' })
      ).toBeInTheDocument();
      cleanup();
      mount();
      expect(within(openMenu()).queryByRole('menuitem', { name: /Also open/ })).toBeNull();
    });
  });

  describe('Forward', () => {
    it('stays out of the menu while the row is wide enough to show it', () => {
      mount({ onForward: () => {}, canForward: true }, 640);
      expect(within(openMenu()).queryByRole('menuitem', { name: 'Forward' })).toBeNull();
    });
    it('moves in below 480px, and goes forward', () => {
      const onForward = vi.fn();
      mount({ onForward, canForward: true }, 400);
      fireEvent.click(within(openMenu()).getByRole('menuitem', { name: 'Forward' }));
      expect(onForward).toHaveBeenCalledOnce();
    });
    it('shows disabled with no page to go to, or no way to go yet', () => {
      mount({ onForward: () => {}, canForward: false }, 400);
      expect(within(openMenu()).getByRole('menuitem', { name: 'Forward' })).toHaveAttribute(
        'data-disabled'
      );
      cleanup();
      mount({}, 400);
      expect(within(openMenu()).getByRole('menuitem', { name: 'Forward' })).toHaveAttribute(
        'data-disabled'
      );
    });
  });

  it('copies the full address', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    mount({ url: 'https://northwind.example/pricing?plan=team' });
    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: 'Copy address' }));
    expect(writeText).toHaveBeenCalledExactlyOnceWith(
      'https://northwind.example/pricing?plan=team'
    );
  });

  it('hands the menu’s button to Close and Forget, for focus to return to', () => {
    const onClose = vi.fn();
    const onForgetSignIns = vi.fn();
    mount({ onClose, onForgetSignIns });
    const button = screen.getByRole('button', { name: 'Browser menu' });
    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: 'Forget saved sign-ins…' }));
    expect(onForgetSignIns).toHaveBeenCalledExactlyOnceWith(button);
    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: 'Close browser' }));
    expect(onClose).toHaveBeenCalledExactlyOnceWith(button);
  });

  it('names its closing item by what it closes', () => {
    mount({ closeLabel: 'Stop sharing' });
    expect(within(openMenu()).getByRole('menuitem', { name: 'Stop sharing' })).toBeInTheDocument();
  });

  it('draws no button when it would hold nothing', () => {
    render(<BrowserMenu url="about:blank" />);
    expect(screen.queryByRole('button', { name: 'Browser menu' })).toBeNull();
  });

  it('names its button with the browser’s own hint, not a Radix tooltip', () => {
    mount();
    const button = screen.getByRole('button', { name: 'Browser menu' });
    expect(button).toHaveAttribute('title', 'Browser menu');
    fireEvent.focus(button);
    expect(document.querySelector('[data-radix-popper-content-wrapper]')).toBeNull();
  });
});
