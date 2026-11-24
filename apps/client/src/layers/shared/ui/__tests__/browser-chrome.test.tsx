// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { BrowserChrome, CHROME_TOOLTIP_DELAY_MS, type BrowserChromeProps } from '../browser-chrome';

// The real packages/ui Button and Radix Tooltip, never stand-ins.
function renderChrome(props: Partial<BrowserChromeProps> = {}) {
  const handlers = {
    onBack: vi.fn(),
    onForward: vi.fn(),
    onReload: vi.fn(),
    onSubmit: vi.fn(),
  };
  const view = render(
    <BrowserChrome
      url="https://www.example.com/docs/guide?x=1"
      canBack
      canForward
      {...handlers}
      {...props}
    />
  );
  return { ...view, ...handlers };
}

describe('BrowserChrome', () => {
  it('says Not secure for plain http:// off this machine, and not for localhost', () => {
    const { rerender } = renderChrome({ url: 'http://shop.example/' });
    expect(screen.getByText('Not secure')).toHaveClass('text-muted-foreground');
    rerender(
      <BrowserChrome
        url="http://localhost:5173/"
        canBack
        canForward
        onBack={vi.fn()}
        onForward={vi.fn()}
        onReload={vi.fn()}
        onSubmit={vi.fn()}
      />
    );
    expect(screen.queryByText('Not secure')).not.toBeInTheDocument();
  });

  it('opens the full address, all selected, and Enter commits what was typed', () => {
    const { onSubmit } = renderChrome();
    fireEvent.click(screen.getByRole('button', { name: /^Address:/ }));
    const input = screen.getByRole('textbox', { name: 'Address' }) as HTMLInputElement;
    expect(input).toHaveValue('https://www.example.com/docs/guide?x=1');
    expect(input).toHaveFocus();
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
    expect(input).toHaveAttribute('placeholder', 'Search DuckDuckGo or type an address');
    fireEvent.change(input, { target: { value: 'weather' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    expect(onSubmit).toHaveBeenCalledWith('weather');
    expect(screen.getByRole('button', { name: /^Address:/ })).toBeInTheDocument();
  });

  it('drives Back, Forward and Reload, and disables what has nowhere to go', () => {
    const { onBack, onForward, onReload, rerender } = renderChrome();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('button', { name: 'Forward' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(onBack).toHaveBeenCalledOnce();
    expect(onForward).toHaveBeenCalledOnce();
    expect(onReload).toHaveBeenCalledOnce();
    rerender(
      <BrowserChrome
        url="https://example.com"
        canBack={false}
        canForward={false}
        onBack={onBack}
        onForward={onForward}
        onReload={onReload}
        onSubmit={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Forward' })).toBeDisabled();
  });

  // DOR-4420 spec §12: at 390px, 10+44+6+field+6+44+44+10.
  describe('on a phone', () => {
    const desktop = window.matchMedia;
    beforeEach(() => {
      Object.defineProperty(window, 'matchMedia', {
        writable: true,
        configurable: true,
        value: vi.fn().mockImplementation((query: string) => ({
          matches: true,
          media: query,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        })),
      });
    });
    afterEach(() => {
      // Back to the setup's desktop answer.
      Object.defineProperty(window, 'matchMedia', {
        writable: true,
        configurable: true,
        value: desktop,
      });
    });

    const field = (container: HTMLElement) =>
      container.querySelector('[data-slot="browser-chrome-field"]') as HTMLElement;

    it('puts Reload inside the right end of the address field', () => {
      const { container, onReload } = renderChrome();
      const reload = screen.getByRole('button', { name: 'Reload' });
      expect(field(container)).toContainElement(reload);
      expect(field(container).lastElementChild).toBe(reload);
      // No Reload slot of its own before the field: Forward (no menu here) is next to it.
      expect(field(container).previousElementSibling).toBe(
        screen.getByRole('button', { name: 'Forward' })
      );
      fireEvent.click(reload);
      expect(onReload).toHaveBeenCalledOnce();
    });
  });

  // DOR-4655 (Security Must): a long, trusted-looking start must never push the real
  // site out of view. The end of the host is kept whole; only the start is elided.
  describe('never hides the end of the host', () => {
    const kept = () =>
      document.querySelector('[data-slot="browser-address-host-kept"]') as HTMLElement;
    const elided = () =>
      document.querySelector('[data-slot="browser-address-host-elided"]') as HTMLElement | null;

    const address = () => screen.getByRole('button', { name: /^Address:/ });
    const host = () => document.querySelector('[data-slot="browser-address-host"]') as HTMLElement;

    /**
     * Lay the field out as a browser would: the at-rest field this wide, and each
     * measured part 8px a character (the icon 15px). jsdom draws nothing itself.
     */
    function withLayout(fieldWidth: number) {
      vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (
        this: Element
      ) {
        return this.getAttribute('aria-label')?.startsWith('Address:') ? fieldWidth : 0;
      });
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: Element
      ) {
        const part = this.getAttribute('data-measure');
        const text = this.getAttribute('data-text') ?? '';
        const width = part === 'badge-icon' ? 15 : part ? text.length * 8 : 0;
        return {
          width,
          height: 0,
          top: 0,
          left: 0,
          right: width,
          bottom: 0,
          x: 0,
          y: 0,
        } as DOMRect;
      });
    }
    afterEach(() => vi.restoreAllMocks());

    it('before anything is measured, shows the whole host free to wrap, never a clipped guess', () => {
      // No layout: first paint, a hidden panel (width 0), no resize yet.
      renderChrome({ url: 'https://accounts.google.com.attacker.example/login' });
      expect(address()).toHaveAttribute('data-host-fit', 'full');
      expect(address()).toHaveAttribute('data-wrap', 'true');
      expect(address()).toHaveClass('h-auto', 'min-h-11');
      expect(host()).toHaveClass('whitespace-normal');
      expect(host().textContent).toBe('accounts.google.com.attacker.example');
      expect(host().style.fontSize).toBe('');
    });

    it('elides the start as "…", whole labels only, and keeps com.attacker.example whole', () => {
      withLayout(200);
      renderChrome({ url: 'https://accounts.google.com.attacker.example/login' });
      expect(address()).toHaveAttribute('data-host-fit', 'elided');
      expect(elided()).toBeNull();
      expect(host().textContent).toBe('…com.attacker.example');
      expect(kept()).toHaveTextContent(/^com\.attacker\.example$/);
      // The path went first.
      expect(document.querySelector('[data-slot="browser-address-path"]')).toBeNull();
      // The full host is still the field's name.
      expect(address()).toHaveAccessibleName('Address: accounts.google.com.attacker.example/login');
    });

    it.each([
      ['evil.github.io', 'https://evil.github.io/'],
      ['login-google.vercel.app', 'https://login-google.vercel.app/'],
      ['192.0.2.10', 'http://192.0.2.10/'],
      ['[2001:db8::1]', 'http://[2001:db8::1]/'],
      ['localhost:5173', 'http://localhost:5173/'],
      ['xn--bcher-kva.example', 'https://xn--bcher-kva.example/'],
    ])('shows %s whole, with nothing elided', (host, url) => {
      renderChrome({ url });
      expect(kept()).toHaveTextContent(host);
      expect(elided()).toBeNull();
    });

    it('keeps the label in front of a two-part ending: attacker.co.za', () => {
      renderChrome({ url: 'https://victim.attacker.co.za/' });
      expect(kept()).toHaveTextContent(/^attacker\.co\.za$/);
      expect(elided()).toHaveTextContent('victim.');
    });
  });

  // DOR-4427: over a native page, a tooltip must never blank the page.
  describe('tooltips over a page that needs a still', () => {
    afterEach(() => vi.useRealTimers());

    /** A still that arrives when the test says so. */
    function deferredStill() {
      let answer!: (ready: boolean) => void;
      const prepare = vi.fn(() => new Promise<boolean>((done) => (answer = done)));
      const release = vi.fn();
      return { still: { prepare, release }, answer: (ready: boolean) => answer(ready) };
    }

    it('waits 500ms on a pointer before it opens a tooltip', async () => {
      vi.useFakeTimers();
      expect(CHROME_TOOLTIP_DELAY_MS).toBeGreaterThanOrEqual(500);
      renderChrome();
      const reload = screen.getByRole('button', { name: 'Reload' });
      fireEvent.pointerMove(reload, { pointerType: 'mouse' });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CHROME_TOOLTIP_DELAY_MS - 100);
      });
      expect(screen.queryByRole('tooltip')).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(screen.getByRole('tooltip')).toHaveTextContent('Reload');
    });

    it('opens only once the still is in place', async () => {
      const { still, answer } = deferredStill();
      renderChrome({ tooltipStill: still });
      fireEvent.focus(screen.getByRole('button', { name: 'Reload' }));
      expect(still.prepare).toHaveBeenCalledOnce();
      // No tooltip, so no cover, until the still is drawn: the page never blinks.
      expect(screen.queryByRole('tooltip')).toBeNull();
      await act(async () => answer(true));
      expect(await screen.findByRole('tooltip')).toHaveTextContent('Reload');
      expect(screen.getByRole('button', { name: 'Reload' })).not.toHaveAttribute('title');
    });
  });

  describe('focusAddress (⌘L, DOR-4432)', () => {
    it('each new request opens the field on the address, all selected', () => {
      const { rerender } = renderChrome({ focusAddress: 0 });
      // A request of 0 is no request: the field stays at rest.
      expect(screen.queryByRole('textbox', { name: 'Address' })).not.toBeInTheDocument();
      rerender(
        <BrowserChrome
          url="https://www.example.com/docs/guide?x=1"
          canBack
          canForward
          onReload={vi.fn()}
          onSubmit={vi.fn()}
          focusAddress={1}
        />
      );
      const input = screen.getByRole('textbox', { name: 'Address' }) as HTMLInputElement;
      expect(input).toHaveValue('https://www.example.com/docs/guide?x=1');
      expect(input).toHaveFocus();
      expect(input.selectionStart).toBe(0);
      expect(input.selectionEnd).toBe(input.value.length);
    });
  });
});
