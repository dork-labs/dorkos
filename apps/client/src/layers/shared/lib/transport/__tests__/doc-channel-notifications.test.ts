import { createMockTransport } from '@dorkos/test-utils';
import { ownDocChannelConnection } from '../doc-channel-ownership';
const producer = ownDocChannelConnection(createMockTransport(), new AbortController().signal);
const publishDocChannelNotification = producer.publish;
import { describe, expect, it, vi } from 'vitest';
import { subscribeDocChannelNotifications } from '../doc-channel-notifications';
import { DOC_EVENT, DOC_SNAPSHOT } from './doc-channel-fixtures';

describe('document notification bus', () => {
  it('routes by validated server scope and allows physical-document consumers across aliases', () => {
    const exact = vi.fn();
    const alias = vi.fn();
    const all = vi.fn();
    const stops = [
      subscribeDocChannelNotifications(DOC_EVENT.scope, exact),
      subscribeDocChannelNotifications('session:alias', alias),
      subscribeDocChannelNotifications(undefined, all),
    ];
    try {
      expect(publishDocChannelNotification(DOC_EVENT)).toBe(true);
      expect(publishDocChannelNotification(DOC_SNAPSHOT)).toBe(true);
      expect(exact.mock.calls.map(([frame]) => frame)).toEqual([DOC_EVENT, DOC_SNAPSHOT]);
      expect(all).toHaveBeenCalledTimes(2);
      expect(alias).not.toHaveBeenCalled();
      stops[0]!();
      publishDocChannelNotification(DOC_EVENT);
      expect(exact).toHaveBeenCalledTimes(2);
      expect(all).toHaveBeenCalledTimes(3);
    } finally {
      stops.forEach((stop) => stop());
    }
  });
  it('rejects malformed and transcript frames and leaves docSeq deduplication to consumers', () => {
    const listener = vi.fn();
    const stop = subscribeDocChannelNotifications(undefined, listener);
    try {
      expect(publishDocChannelNotification({ ...DOC_EVENT, docSeq: -1 })).toBe(false);
      expect(publishDocChannelNotification({ ...DOC_EVENT, authority: 'operator' })).toBe(false);
      expect(publishDocChannelNotification({ type: 'turn_start', seq: 1 })).toBe(false);
      publishDocChannelNotification(DOC_EVENT);
      publishDocChannelNotification(DOC_EVENT);
      expect(listener).toHaveBeenCalledTimes(2);
    } finally {
      stop();
    }
  });
});
