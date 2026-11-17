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
  it('draws the address simply: no scheme or www., host strong, path muted', () => {
    renderChrome();
    const field = screen.getByRole('button', { name: 'Address: example.com/docs/guide?x=1' });
    expect(field).toHaveTextContent('example.com/docs/guide?x=1');
    expect(screen.getByText('example.com')).toHaveClass('text-foreground');
    const path = screen.getByText('/docs/guide?x=1');
    expect(path).toHaveClass('text-muted-foreground');
    // Below 480px of chrome only the host shows.
    expect(path).toHaveClass('hidden', '@min-[480px]/browser-chrome:inline');
    expect(screen.queryByText('Not secure')).not.toBeInTheDocument();
  });

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

  // DOR-4450: a page the http:// fallback opened keeps "Not secure" and says why.
  const WHY = 'This site didn’t answer over https, so it opened over http.';

  it('keeps Not secure for a fallback page, and its tooltip and description say why', () => {
    renderChrome({ url: 'http://nas.example:5000/', openedOverHttp: true });
    expect(screen.getByText('Not secure')).toHaveAttribute('title', WHY);
    expect(screen.queryByText('Opened over http')).not.toBeInTheDocument();
    const field = screen.getByRole('button', { name: /^Address: nas\.example/ });
    expect(field).toHaveAccessibleDescription(WHY);
  });

  it('gives a plain http page no new tooltip or description', () => {
    renderChrome({ url: 'http://shop.example/' });
    expect(screen.getByText('Not secure')).not.toHaveAttribute('title');
    expect(
      screen.getByRole('button', { name: /^Address: shop\.example/ })
    ).not.toHaveAccessibleDescription();
  });

  it('ignores the fallback mark once the address is no longer http://', () => {
    renderChrome({ url: 'https://nas.example/', openedOverHttp: true });
    expect(screen.queryByText('Not secure')).not.toBeInTheDocument();
    expect(screen.queryByText(WHY)).not.toBeInTheDocument();
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

  it('puts the address back on Escape and on blur, without committing', () => {
    const { onSubmit } = renderChrome();
    fireEvent.click(screen.getByRole('button', { name: /^Address:/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Address' }), {
      target: { value: 'typed' },
    });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Address' }), { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'Address' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Address:/ }));
    fireEvent.blur(screen.getByRole('textbox', { name: 'Address' }));
    expect(screen.queryByRole('textbox', { name: 'Address' })).not.toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
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

  it('turns Reload into Stop while loading, when it can stop', () => {
    const onStop = vi.fn();
    const { onReload } = renderChrome({ loading: true, onStop });
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onStop).toHaveBeenCalledOnce();
    expect(onReload).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Reload' })).not.toBeInTheDocument();
  });

  it('disables a button with no handler and names it plainly', async () => {
    renderChrome({ onBack: undefined });
    const back = screen.getByRole('button', { name: 'Back' });
    expect(back).toBeDisabled();
    expect(back).not.toHaveAttribute('title');
  });

  it('names every button in a tooltip, keeping its aria-label and no title hint', async () => {
    renderChrome({ loading: true, onStop: vi.fn() });
    for (const name of ['Back', 'Forward', 'Stop']) {
      const button = screen.getByRole('button', { name });
      expect(button).toHaveAttribute('aria-label', name);
      expect(button).not.toHaveAttribute('title');
    }
    fireEvent.focus(screen.getByRole('button', { name: 'Stop' }));
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Stop');
  });

  it('keeps the field open on Enter while busy, and disables Reload', () => {
    const { onSubmit } = renderChrome({ busy: true });
    expect(screen.getByRole('button', { name: 'Reload' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /^Address:/ }));
    const input = screen.getByRole('textbox', { name: 'Address' });
    fireEvent.change(input, { target: { value: 'weather' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Address' })).toHaveValue('weather');
  });

  it('shows the notice line only when there is something to say, as an alert', () => {
    const { rerender } = renderChrome();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    rerender(
      <BrowserChrome
        url="https://example.com"
        canBack
        canForward
        onReload={vi.fn()}
        onSubmit={vi.fn()}
        notice="Only web pages open here. Try an address starting with https://."
      />
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Only web pages open here.');
    expect(screen.getByRole('alert')).toHaveClass('min-h-7');
    // A glyph in front of the words makes it read as a refusal, not a hint.
    expect(screen.getByRole('alert').querySelector('svg.text-destructive')).not.toBeNull();
    // The words are full strength; only the glyph is red (spec §2).
    expect(screen.getByRole('alert')).toHaveClass('text-foreground');
    expect(screen.getByRole('alert')).not.toHaveClass('text-muted-foreground');
  });

  it('turns the seam brand orange while an agent drives', () => {
    const { container, rerender } = renderChrome();
    const seam = () => container.querySelector('[data-slot="browser-chrome-seam"]');
    expect(seam()).toHaveClass('h-0.5', 'bg-foreground/5');
    rerender(
      <BrowserChrome
        url="https://example.com"
        canBack
        canForward
        onBack={vi.fn()}
        onForward={vi.fn()}
        onReload={vi.fn()}
        onSubmit={vi.fn()}
        agentDriving
      />
    );
    expect(seam()).toHaveClass('bg-brand');
  });

  it('moves Forward into the menu below 480px only once there is a menu', () => {
    const { rerender } = renderChrome();
    expect(screen.getByRole('button', { name: 'Forward' })).not.toHaveClass('hidden');
    rerender(
      <BrowserChrome
        url="https://example.com"
        canBack
        canForward
        onBack={vi.fn()}
        onForward={vi.fn()}
        onReload={vi.fn()}
        onSubmit={vi.fn()}
        menu={<button type="button">More</button>}
      />
    );
    expect(screen.getByRole('button', { name: 'Forward' })).toHaveClass(
      'hidden',
      '@min-[480px]/browser-chrome:inline-flex'
    );
  });

  it('reopens the field on a retry, once per attempt, holding what was typed', () => {
    const props = {
      url: 'https://example.com',
      canBack: true,
      canForward: true,
      onBack: vi.fn(),
      onForward: vi.fn(),
      onReload: vi.fn(),
      onSubmit: vi.fn(),
    };
    const { rerender } = render(
      <BrowserChrome {...props} retry={{ draft: 'file:///x', attempt: 1 }} />
    );
    expect(screen.getByRole('textbox', { name: 'Address' })).toHaveValue('file:///x');
    fireEvent.submit(
      screen.getByRole('textbox', { name: 'Address' }).closest('form') as HTMLFormElement
    );
    expect(screen.queryByRole('textbox', { name: 'Address' })).not.toBeInTheDocument();
    rerender(<BrowserChrome {...props} retry={{ draft: 'file:///x', attempt: 2 }} />);
    expect(screen.getByRole('textbox', { name: 'Address' })).toHaveValue('file:///x');
  });

  it('sets the address at rest in the field text size, so tapping it never changes the size', () => {
    renderChrome();
    const field = screen.getByRole('button', { name: /^Address:/ });
    expect(field).toHaveClass('text-field');
    expect(field).not.toHaveClass('text-sm');
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

    it('keeps the address text, Not secure included, clear of Reload', () => {
      // DOR-4436 round 3: at 258px "Not secure" plus the host ran under Reload.
      const { container } = renderChrome({ url: 'http://printer.example/status' });
      const field = screen.getByRole('button', { name: /^Address:/ });
      // Reload's 44px is the field's right padding, and the text lives in a box that clips
      // at that padding, so nothing it holds can draw under Reload.
      expect(field).toHaveClass('pr-11');
      const text = container.querySelector('[data-slot="browser-address-text"]')!;
      expect(field).toContainElement(text as HTMLElement);
      expect(text).toHaveClass('min-w-0', 'flex-1', 'overflow-hidden');
      expect(text).toContainElement(screen.getByText('Not secure'));
      // The host shrinks, clipping from the left, rather than pushing past it (DOR-4655).
      const host = screen.getByText('printer.example').parentElement!;
      expect(host).toHaveAttribute('data-slot', 'browser-address-host');
      expect(host).toHaveClass('min-w-0', 'overflow-hidden', 'justify-end');
    });

    it('shrinks Not secure to an open-lock icon below 360px of chrome, keeping its words', () => {
      renderChrome({ url: 'http://printer.example/status' });
      const badge = screen.getByText('Not secure');
      // Words at zero size (still read aloud), and the icon only shows below 360px.
      expect(badge).toHaveClass('@max-[359px]/browser-chrome:text-[0px]');
      const icon = badge.querySelector('svg')!;
      expect(icon).toHaveAttribute('aria-hidden', 'true');
      expect(icon).toHaveClass('@min-[360px]/browser-chrome:hidden');
    });

    it('never lets the field shrink under Reload plus a sliver of host', () => {
      // DOR-4436 round 2: 88px is Reload's 44 plus 44 of host, which still truncates.
      const { container } = renderChrome();
      expect(field(container)).toHaveClass('max-md:min-w-22');
    });

    it('turns that Reload into Stop while loading', () => {
      const onStop = vi.fn();
      const { container } = renderChrome({ loading: true, onStop });
      const stop = screen.getByRole('button', { name: 'Stop' });
      expect(field(container)).toContainElement(stop);
      fireEvent.click(stop);
      expect(onStop).toHaveBeenCalledOnce();
    });

    it('spaces the row 6px around the field, with the pill and ⋯ side by side', () => {
      const { container } = renderChrome({
        status: <button type="button">Status</button>,
        menu: <button type="button">More</button>,
      });
      const row = container.querySelector('[data-slot="browser-chrome-row"]');
      expect(row).toHaveClass('h-12', 'px-2.5', 'gap-1.5', 'md:h-9', 'md:gap-1');
      const end = container.querySelector('[data-slot="browser-chrome-end"]');
      expect(end).toContainElement(screen.getByRole('button', { name: 'Status' }));
      expect(end).toContainElement(screen.getByRole('button', { name: 'More' }));
      expect(end).toHaveClass('gap-0', 'md:gap-1');
    });
  });

  it('adds no gap for an end group whose menu renders nothing', () => {
    function NothingToOffer() {
      return null;
    }
    const { container } = renderChrome({ menu: <NothingToOffer /> });
    const end = container.querySelector('[data-slot="browser-chrome-end"]');
    // jsdom applies no `:empty`; the class is what hides it in a real browser.
    expect(end).toBeEmptyDOMElement();
    expect(end).toHaveClass('empty:hidden');
  });

  it('keeps Reload its own button before the field off a phone', () => {
    const { container } = renderChrome();
    const reload = screen.getByRole('button', { name: 'Reload' });
    expect(container.querySelector('[data-slot="browser-chrome-field"]')).not.toContainElement(
      reload
    );
    expect(reload.nextElementSibling).toBe(
      container.querySelector('[data-slot="browser-chrome-field"]')
    );
  });

  // DOR-4655 (Security Must): a long, trusted-looking start must never push the real
  // site out of view. The end of the host is kept whole; only the start is elided.
  describe('never hides the end of the host', () => {
    const kept = () =>
      document.querySelector('[data-slot="browser-address-host-kept"]') as HTMLElement;
    const elided = () =>
      document.querySelector('[data-slot="browser-address-host-elided"]') as HTMLElement | null;

    it('keeps com.attacker.example whole, and elides only the start, with an ellipsis', () => {
      renderChrome({ url: 'https://accounts.google.com.attacker.example/login' });
      expect(kept()).toHaveTextContent(/^com\.attacker\.example$/);
      // Never shrinks: the start goes first, from the left.
      expect(kept()).toHaveClass('shrink-0');
      const host = document.querySelector('[data-slot="browser-address-host"]')!;
      expect(host).toHaveClass('justify-end', 'overflow-hidden', 'min-w-0');
      // Below 480px of chrome the start is an ellipsis; from 480 it shows in full.
      expect(elided()).toHaveTextContent('accounts.google.');
      expect(elided()).toHaveClass('@max-[479px]/browser-chrome:hidden');
      const dots = host.querySelector('[data-slot="browser-address-host-ellipsis"]')!;
      expect(dots).toHaveTextContent('…');
      expect(dots).toHaveClass('@min-[480px]/browser-chrome:hidden');
      // The visible text, read left to right, ends with the real site.
      expect(host.textContent).toMatch(/attacker\.example$/);
      // The full host is still the field's name.
      expect(screen.getByRole('button', { name: /^Address:/ })).toHaveAccessibleName(
        'Address: accounts.google.com.attacker.example/login'
      );
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

    it('lets the path give way before the host', () => {
      renderChrome({ url: 'https://accounts.google.com.attacker.example/a/very/long/path' });
      const path = document.querySelector('[data-slot="browser-address-path"]')!;
      expect(path).toHaveClass('min-w-0', 'truncate');
      expect(path).toHaveTextContent('/a/very/long/path');
    });
  });

  it('shows an empty page as the placeholder, named as a new page', () => {
    renderChrome({ url: 'about:blank' });
    expect(screen.getByRole('button', { name: 'Address: New page' })).toHaveTextContent(
      'Search DuckDuckGo or type an address'
    );
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

    it('waits the full delay again on the next hover, once the quick-reopen window has passed', async () => {
      vi.useFakeTimers();
      const still = { prepare: vi.fn(() => Promise.resolve(true)), release: vi.fn() };
      renderChrome({ tooltipStill: still });
      const reload = screen.getByRole('button', { name: 'Reload' });
      const hover = async (ms: number) => {
        fireEvent.pointerMove(reload, { pointerType: 'mouse' });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(ms);
        });
      };
      await hover(CHROME_TOOLTIP_DELAY_MS + 100);
      expect(screen.getByRole('tooltip')).toHaveTextContent('Reload');
      fireEvent.pointerLeave(reload, { pointerType: 'mouse' });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(screen.queryByRole('tooltip')).toBeNull();
      // A fresh hover: nothing inside the delay, exactly as the first time.
      await hover(CHROME_TOOLTIP_DELAY_MS - 100);
      expect(screen.queryByRole('tooltip')).toBeNull();
      await hover(200);
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

    it('keeps the page and a plain hint when there is no still', async () => {
      const { still, answer } = deferredStill();
      renderChrome({ tooltipStill: still });
      fireEvent.focus(screen.getByRole('button', { name: 'Reload' }));
      await act(async () => answer(false));
      expect(screen.queryByRole('tooltip')).toBeNull();
      expect(screen.getByRole('button', { name: 'Reload' })).toHaveAttribute('title', 'Reload');
      expect(screen.getByRole('button', { name: 'Reload' })).toHaveAttribute(
        'aria-label',
        'Reload'
      );
      expect(still.release).toHaveBeenCalled();
    });

    it('opens nothing when the pointer left before the still came', async () => {
      const { still, answer } = deferredStill();
      renderChrome({ tooltipStill: still });
      const reload = screen.getByRole('button', { name: 'Reload' });
      fireEvent.focus(reload);
      fireEvent.blur(reload);
      expect(still.release).toHaveBeenCalledOnce();
      await act(async () => answer(true));
      // The late answer is ignored: no tooltip, and nothing more to give back.
      expect(screen.queryByRole('tooltip')).toBeNull();
      expect(still.release).toHaveBeenCalledOnce();
    });

    it('opens nothing when the button is pressed before the still came', async () => {
      const { still, answer } = deferredStill();
      const { onReload } = renderChrome({ tooltipStill: still });
      const reload = screen.getByRole('button', { name: 'Reload' });
      fireEvent.focus(reload);
      fireEvent.pointerDown(reload);
      fireEvent.click(reload);
      await act(async () => answer(true));
      expect(onReload).toHaveBeenCalledOnce();
      expect(screen.queryByRole('tooltip')).toBeNull();
    });

    it('asks for one still per hover, however many ways the button is reached', async () => {
      vi.useFakeTimers();
      const { still, answer } = deferredStill();
      renderChrome({ tooltipStill: still });
      const reload = screen.getByRole('button', { name: 'Reload' });
      fireEvent.pointerMove(reload, { pointerType: 'mouse' });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(CHROME_TOOLTIP_DELAY_MS + 50);
      });
      fireEvent.focus(reload);
      expect(still.prepare).toHaveBeenCalledOnce();
      await act(async () => answer(true));
      expect(screen.getByRole('tooltip')).toHaveTextContent('Reload');
      expect(still.release).not.toHaveBeenCalled();
    });

    it('gives its still back when it goes away mid-hover', async () => {
      const { still, answer } = deferredStill();
      const view = renderChrome({ tooltipStill: still });
      fireEvent.focus(screen.getByRole('button', { name: 'Reload' }));
      await act(async () => answer(true));
      expect(await screen.findByRole('tooltip')).toBeInTheDocument();
      view.unmount();
      expect(still.release).toHaveBeenCalledOnce();
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

    it('a request while typing selects everything again, keeping what was typed', () => {
      const props = {
        url: 'https://www.example.com/',
        canBack: true,
        canForward: true,
        onReload: vi.fn(),
        onSubmit: vi.fn(),
      };
      const { rerender } = render(<BrowserChrome {...props} focusAddress={0} />);
      rerender(<BrowserChrome {...props} focusAddress={1} />);
      const input = screen.getByRole('textbox', { name: 'Address' }) as HTMLInputElement;
      fireEvent.change(input, { target: { value: 'contoso.example' } });
      input.setSelectionRange(3, 3);
      rerender(<BrowserChrome {...props} focusAddress={2} />);
      expect(input).toHaveValue('contoso.example');
      expect(input).toHaveFocus();
      expect(input.selectionStart).toBe(0);
      expect(input.selectionEnd).toBe('contoso.example'.length);
    });

    it('a request already made when the field appears is old: it stays at rest, focus stays put', () => {
      // A refused address remounts the field (it is keyed on the retry) while an old ⌘L
      // is still counted; that count must not reopen it or pull focus.
      render(<button type="button">Elsewhere</button>);
      const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
      elsewhere.focus();
      renderChrome({ focusAddress: 3 });
      expect(screen.queryByRole('textbox', { name: 'Address' })).not.toBeInTheDocument();
      expect(elsewhere).toHaveFocus();
    });
  });
});
