/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { roomTabIdentity } from '../lib/tab-identity';
import { TabIdentityCard } from '../ui/TabHoverCard';
import { AppTabItemView } from '../ui/AppTabItem';

afterEach(cleanup);

// DOR-3593: a busy channel's tab is bold with no number, the sidebar row's
// first tier; a mention of you adds the count.
describe('a room tab, drawn', () => {
  it('draws a busy background channel bold, with no count', () => {
    render(
      <AppTabItemView
        identity={roomTabIdentity({ kind: 'channel', title: '#general', unreadCount: 40 })}
        isActive={false}
        canClose={false}
      />
    );
    const tab = screen.getByRole('tab', { name: '#general, New messages' });
    expect(tab.dataset.emphasized).toBe('true');
    expect(screen.getByText('general').className).toContain('font-semibold');
    expect(tab.querySelector('[data-slot="tab-count"]')).toBeNull();
  });

  it('adds the mention count to a channel that names you', () => {
    render(
      <AppTabItemView
        identity={roomTabIdentity({
          kind: 'channel',
          title: '#general',
          unreadCount: 40,
          mentionCount: 3,
        })}
        isActive={false}
        canClose={false}
      />
    );
    const tab = screen.getByRole('tab', { name: '#general, 3 mentions' });
    expect(tab.querySelector('[data-slot="tab-count"]')?.textContent).toBe('3');
  });

  it('leaves the tab on screen at its usual weight', () => {
    render(
      <AppTabItemView
        identity={roomTabIdentity({ kind: 'channel', title: '#general', unreadCount: 40 })}
        isActive
        canClose={false}
      />
    );
    expect(screen.getByRole('tab').dataset.emphasized).toBeUndefined();
    expect(screen.getByText('general').className).toContain('font-medium');
  });

  // DOR-2073: the Hash glyph draws a channel's `#`, so the text beside it is the
  // bare slug, and the full `#general` lives only in the spoken name.
  it('never prints the `#` its glyph already draws', () => {
    render(
      <AppTabItemView
        identity={roomTabIdentity({ kind: 'channel', title: '#general', unreadCount: 0 })}
        isActive={false}
        canClose={false}
      />
    );
    const tab = screen.getByRole('tab', { name: '#general' });
    expect(tab.textContent).toBe('general');
  });

  it('keeps the `#` out of the hover card’s visible text but in what it says', () => {
    render(
      <TabIdentityCard
        identity={roomTabIdentity({ kind: 'channel', title: '#general', unreadCount: 4 })}
      />
    );
    expect(screen.getByText('general', { selector: ':not(.sr-only)' })).toBeTruthy();
    expect(screen.getByText('#general', { selector: '.sr-only' })).toBeTruthy();
    expect(screen.queryByText('#general', { selector: ':not(.sr-only)' })).toBeNull();
  });

  it('leaves a DM’s name alone, whatever it starts with', () => {
    render(
      <AppTabItemView
        identity={roomTabIdentity({ kind: 'dm', title: '#1 fan' })}
        isActive={false}
        canClose={false}
      />
    );
    expect(screen.getByRole('tab').textContent).toContain('#1 fan');
  });
});
