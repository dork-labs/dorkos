// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Globe } from 'lucide-react';
import { PanelViewsMenu } from '../ui/PanelViewsMenu';
import type { PanelView } from '../model/use-panel-views';

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});
const browser: PanelView = {
  id: 'local-browser',
  category: 'local-browser',
  title: 'Browser',
  icon: Globe,
  component: () => null,
};

describe('resource panel Browser menu', () => {
  it('offers exactly one Browser entry and reopens the closed live resource instead of creating a preview', async () => {
    const activate = vi.fn();
    const createPreview = vi.fn();
    const live: PanelView = {
      ...browser,
      resource: 'browser',
      id: 'resource/browser/chat/one/connection',
      title: 'Signed-in report',
      closed: true,
    };
    const preview: PanelView = {
      ...browser,
      id: 'browser',
      category: 'browser',
      title: 'Page previews',
    };
    render(
      <PanelViewsMenu
        views={[browser, live, preview]}
        activeId={null}
        onActivate={activate}
        onCreateBrowser={createPreview}
      />
    );
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Add view' }), {
      button: 0,
      ctrlKey: false,
    });
    const item = await screen.findByRole('menuitem', { name: /^Browser$/ });
    expect(screen.getAllByRole('menuitem', { name: /^Browser$/ })).toHaveLength(1);
    expect(screen.getByText('Signed-in report')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Page previews' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'New page preview' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'New browser page' })).not.toBeInTheDocument();
    fireEvent.click(item);
    expect(activate).toHaveBeenCalledExactlyOnceWith(live.id);
    expect(createPreview).not.toHaveBeenCalled();
  });
  it('opens Browser controls when no live connection exists', async () => {
    const activate = vi.fn();
    render(<PanelViewsMenu views={[browser]} activeId={null} onActivate={activate} />);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Add view' }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Browser$/ }));
    expect(activate).toHaveBeenCalledExactlyOnceWith('local-browser');
  });
});
