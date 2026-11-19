import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { Page, JSHandle } from 'playwright-core';
import { BrowserPageReadings } from '../page-readings.js';
import { actionFence } from '../../page-action.js';
import { LocalBrowserError } from '../../errors.js';
import type { ObservedPageNodes } from '../../observation-nodes.js';

describe('a refusal-only page reading', () => {
  it('consumes a held DOM lease before returning metadata', () => {
    const events = new EventEmitter();
    const frame = {};
    const url = 'https://fixture.example/blank';
    const page = {
      url: () => url,
      isClosed: () => false,
      mainFrame: () => frame,
      on: events.on.bind(events),
    } as unknown as Page;
    let revision = 1;
    const stale = () => new LocalBrowserError('stale_page', 'The page changed.');
    const readings = new BrowserPageReadings({
      state: () => ({
        page,
        connectionId: 'connection',
        tabId: 'tab',
        connected: true,
        paused: false,
        revision,
        frames: 0,
      }),
      page: () => page,
      protect: () => undefined,
      stale,
      invalidate: () => {
        revision++;
        readings.clear();
      },
    });
    const dispose = vi.fn(async () => undefined);
    readings.nodes = { dispose } as unknown as JSHandle<ObservedPageNodes>;
    readings.observation = { revision, tabId: 'tab', url, snapshot: '- button "Save"' };
    readings.navigation.watch(page);
    for (let i = 0; i < 4; i++) {
      events.emit('request', {
        isNavigationRequest: () => true,
        frame: () => frame,
        url: () => url,
      });
      events.emit('framenavigated', frame);
    }
    const refused = readings.observeRefusal();
    expect(refused.refusal?.kind).toBe('blocked');
    expect(refused.revision).toBe(2);
    expect(readings.nodes).toBeUndefined();
    expect(dispose).toHaveBeenCalledOnce();
    expect(() =>
      actionFence(
        { kind: 'click', role: 'button', name: 'Save', revision: refused.revision },
        refused,
        Boolean(readings.nodes),
        revision,
        stale
      )
    ).toThrow(stale());
  });
});
