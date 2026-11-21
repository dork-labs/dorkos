import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { Page, JSHandle } from 'playwright-core';
import { BrowserPageState } from '../../leases/page-state.js';
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
    const stale = () => new LocalBrowserError('stale_page', 'The page changed.');
    const readings = new BrowserPageState(
      (operation) => operation,
      () => undefined,
      () => true
    );
    readings.revision = 1;
    readings.selectedTabId = 'tab';
    const dispose = vi.fn(async () => undefined);
    readings.observedNodes = { dispose } as unknown as JSHandle<ObservedPageNodes>;
    readings.observation = {
      revision: readings.revision,
      tabId: 'tab',
      url,
      snapshot: '- button "Save"',
    };
    readings.navigation.watch(page);
    for (let i = 0; i < 4; i++) {
      events.emit('request', {
        isNavigationRequest: () => true,
        frame: () => frame,
        url: () => url,
      });
      events.emit('framenavigated', frame);
    }
    const refused = readings.observeRefusal(page, () => undefined);
    expect(refused.refusal?.kind).toBe('blocked');
    expect(refused.revision).toBe(2);
    expect(readings.observedNodes).toBeUndefined();
    expect(dispose).toHaveBeenCalledOnce();
    expect(() =>
      actionFence(
        { kind: 'click', role: 'button', name: 'Save', revision: refused.revision },
        refused,
        Boolean(readings.observedNodes),
        readings.revision,
        stale
      )
    ).toThrow(stale());
  });
});
