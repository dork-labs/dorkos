// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { TooltipProvider } from '@/layers/shared/ui';

// Which route this browser came in on (DOR-3037).
const onWifi = vi.hoisted(() => ({ value: false }));
vi.mock('@/layers/entities/config', () => ({ useOnWifi: () => onWifi.value }));
// A phone (coarse pointer, nothing fine attached) or a desktop.
const touchOnly = vi.hoisted(() => ({ value: false }));
vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/model')>()),
  useIsTouchOnly: () => touchOnly.value,
}));

import { WIFI_TURN_CAP_DETAIL, WIFI_TURN_CAP_LABEL, WifiTurnCapPill } from '../ui/WifiTurnCapPill';

function renderPill(compact?: boolean) {
  return render(
    <TooltipProvider delayDuration={0}>
      <WifiTurnCapPill compact={compact} />
    </TooltipProvider>
  );
}

afterEach(() => {
  cleanup();
  onWifi.value = false;
  touchOnly.value = false;
});

describe('WifiTurnCapPill', () => {
  it('says agents ask or only read on Wi-Fi, and why on focus', async () => {
    onWifi.value = true;
    renderPill();
    const pill = screen.getByTestId('wifi-turn-cap');
    expect(pill).toHaveTextContent(WIFI_TURN_CAP_LABEL);
    await userEvent.tab();
    expect(pill).toHaveFocus();
    expect((await screen.findAllByText(WIFI_TURN_CAP_DETAIL)).length).toBeGreaterThan(0);
  });

  it('shows only its icon on a narrow line, keeping the full sentence for a screen reader', () => {
    onWifi.value = true;
    renderPill(true);
    const pill = screen.getByTestId('wifi-turn-cap');
    // The icon alone at phone width, so the chip beside it keeps its words.
    expect(pill).toHaveTextContent('');
    expect(pill.querySelector('svg')).not.toBeNull();
    expect(pill).toHaveAccessibleName(`${WIFI_TURN_CAP_LABEL}. ${WIFI_TURN_CAP_DETAIL}`);
  });

  it('has a 44px hit area while the icon stays small', () => {
    onWifi.value = true;
    renderPill(true);
    const pill = screen.getByTestId('wifi-turn-cap');
    // An invisible 44px pseudo-element, so the line's height does not change.
    expect(pill.className).toContain('after:size-11');
    expect(pill.className).toContain('after:absolute');
    expect(pill.className).toContain('relative');
  });

  it('opens the line in a popover on tap on a touch device', async () => {
    onWifi.value = true;
    touchOnly.value = true;
    renderPill(true);
    expect(screen.queryByTestId('wifi-turn-cap-detail')).toBeNull();

    await userEvent.click(screen.getByTestId('wifi-turn-cap'));
    const detail = await screen.findByTestId('wifi-turn-cap-detail');
    expect(detail).toHaveTextContent(WIFI_TURN_CAP_DETAIL);
    // Wraps at about 280px.
    expect(detail.className).toContain('max-w-70');

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByTestId('wifi-turn-cap-detail')).toBeNull();
  });

  it('draws nothing at this computer', () => {
    renderPill();
    expect(screen.queryByTestId('wifi-turn-cap')).toBeNull();
  });
});
