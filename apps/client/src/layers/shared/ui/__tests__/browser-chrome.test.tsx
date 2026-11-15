import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { BrowserChrome, type BrowserChromeProps } from '../browser-chrome';

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

  it('names Back in a tooltip, and never says it is coming soon', async () => {
    renderChrome();
    fireEvent.focus(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('tooltip')).toHaveTextContent(/^Back$/);
  });

  it('names its buttons with a title hint when tooltips are off, and still drives them', () => {
    const { onBack } = renderChrome({ canBack: true, canForward: false, tooltips: false });
    const back = screen.getByRole('button', { name: 'Back' });
    expect(back).toHaveAttribute('title', 'Back');
    expect(back).toBeEnabled();
    fireEvent.click(back);
    expect(onBack).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Forward' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reload' })).toHaveAttribute('title', 'Reload');
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
        onBack={vi.fn()}
        onForward={vi.fn()}
        onReload={vi.fn()}
        onSubmit={vi.fn()}
        notice="Only web pages open here. Try an address starting with https://."
      />
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Only web pages open here.');
    expect(alert).toHaveClass('min-h-7');
    // The words are full strength; only the glyph is red (spec §2).
    expect(alert).toHaveClass('text-foreground');
    expect(alert).not.toHaveClass('text-muted-foreground');
    expect(alert.querySelector('svg')).toHaveClass('text-destructive');
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

  it('shows an empty page as the placeholder, named as a new page', () => {
    renderChrome({ url: 'about:blank' });
    expect(screen.getByRole('button', { name: 'Address: New page' })).toHaveTextContent(
      'Search DuckDuckGo or type an address'
    );
  });
});
