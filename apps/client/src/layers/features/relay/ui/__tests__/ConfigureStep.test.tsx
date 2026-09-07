/**
 * The Configure step's action button opens a URL that came from an adapter
 * manifest — `actionButton.url`, declared as a bare `z.string()` and shipped by
 * whoever wrote the adapter, marketplace-installed ones included. It used to be
 * a bare `<a href>`, which the browser follows with none of the app's link
 * policy in the path (DOR-924).
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { AdapterManifest } from '@dorkos/shared/relay-schemas';
import { ConfigureStep } from '../wizard/ConfigureStep';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { toast } from 'sonner';

const open = vi.fn();

beforeEach(() => {
  open.mockReset();
  vi.mocked(toast.error).mockReset();
  vi.stubGlobal('open', open);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The two form slots `ConfigureStep` renders through, with no form behind them. */
const form = {
  Subscribe: ({ children }: { children: (v: Record<string, unknown>) => ReactNode }) => (
    <>{children({})}</>
  ),
  AppField: () => null,
};

function manifestWith(url: string): AdapterManifest {
  return {
    type: 'telegram',
    displayName: 'Telegram',
    description: 'Chat over Telegram',
    category: 'messaging',
    builtin: true,
    configFields: [],
    multiInstance: false,
    actionButton: { label: 'Open BotFather', url },
  };
}

function renderStep(url: string) {
  return render(
    <ConfigureStep
      manifest={manifestWith(url)}
      label=""
      onLabelChange={vi.fn()}
      fields={[]}
      form={form}
    />
  );
}

describe('ConfigureStep action button', () => {
  it('links to a well-formed https action URL and dispatches it through the seam', () => {
    renderStep('https://t.me/botfather');

    const link = screen.getByText('Open BotFather').closest('a');
    expect(link?.getAttribute('href')).toBe('https://t.me/botfather');

    fireEvent.click(link as HTMLAnchorElement);
    expect(open).toHaveBeenCalledWith('https://t.me/botfather', '_blank', 'noopener,noreferrer');
  });

  it('renders no href for a manifest naming a scheme the app refuses', () => {
    renderStep('javascript:alert(document.cookie)');

    const link = screen.getByText('Open BotFather').closest('a');
    expect(link?.hasAttribute('href')).toBe(false);

    fireEvent.click(link as HTMLAnchorElement);
    expect(open).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalled();
  });

  it('refuses a data: action URL too — the one React does not neutralise on its own', () => {
    renderStep('data:text/html,<script>alert(1)</script>');

    const link = screen.getByText('Open BotFather').closest('a');
    expect(link?.hasAttribute('href')).toBe(false);
  });

  it('is one control, not a button nested inside a link', () => {
    // The anchor used to wrap a native `<button>`. That is invalid on its own,
    // and on the refused path the anchor is itself a `role="button"` — two tab
    // stops for one action, the first of them invisible.
    renderStep('data:text/html,<script>alert(1)</script>');

    const link = screen.getByText('Open BotFather').closest('a');
    expect(link?.querySelector('button')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Open BotFather' })).toHaveLength(1);
  });
});
