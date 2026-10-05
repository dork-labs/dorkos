import { describe, expect, it, vi } from 'vitest';
import { createMockTransport } from '@dorkos/test-utils';
import { ownDocChannelConnection, openOwnedRoomDocStream } from '../doc-channel-ownership';
import {
  publishOwnedDocChannelNotification,
  subscribeDocChannelNotifications,
} from '../doc-channel-notifications';
import { DOC_EVENT } from './doc-channel-fixtures';

describe('owned document stream admission', () => {
  it('refuses a plain token and filters equal payloads by the actual Transport owner', () => {
    const first = createMockTransport();
    const other = createMockTransport();
    const controller = new AbortController();
    const producer = ownDocChannelConnection(first, controller.signal);
    const yes = vi.fn();
    const no = vi.fn();
    const stops = [
      subscribeDocChannelNotifications(undefined, yes, first),
      subscribeDocChannelNotifications(undefined, no, other),
    ];
    try {
      expect(publishOwnedDocChannelNotification({}, DOC_EVENT)).toBe(false);
      expect(producer.publish(DOC_EVENT)).toBe(true);
      expect(yes).toHaveBeenCalledOnce();
      expect(no).not.toHaveBeenCalled();
      controller.abort();
      expect(producer.publish(DOC_EVENT)).toBe(false);
      expect(yes).toHaveBeenCalledOnce();
    } finally {
      producer.retire();
      stops.forEach((stop) => stop());
    }
  });
  it('clears admission before retirement callbacks and stops after subscriber reentry', () => {
    const owner = createMockTransport();
    const controller = new AbortController();
    const producer = ownDocChannelConnection(owner, controller.signal);
    const late = vi.fn();
    const retired = vi.fn(() => expect(producer.current()).toBe(false));
    const stops = [
      subscribeDocChannelNotifications(undefined, () => producer.retire(), owner, retired),
      subscribeDocChannelNotifications(undefined, late, owner),
    ];
    try {
      expect(producer.publish(DOC_EVENT)).toBe(false);
      expect(retired).toHaveBeenCalledOnce();
      expect(late).not.toHaveBeenCalled();
    } finally {
      producer.retire();
      stops.forEach((stop) => stop());
    }
  });
  it('opens the actual room subscription with its original signal and retires after abort', () => {
    const owner = createMockTransport();
    const controller = new AbortController();
    const owned = openOwnedRoomDocStream(owner, 'room-1', 7, controller.signal);
    expect(owner.subscribeRoom).toHaveBeenCalledWith('room-1', 7, controller.signal);
    expect(owned.current()).toBe(true);
    controller.abort();
    expect(owned.current()).toBe(false);
    expect(owned.publish(DOC_EVENT)).toBe(false);
  });
});

it('drains sibling retirement and removes its abort listener despite a throwing subscriber', () => {
  const owner = createMockTransport();
  const controller = new AbortController();
  const removed = vi.spyOn(controller.signal, 'removeEventListener');
  const producer = ownDocChannelConnection(owner, controller.signal);
  const later = vi.fn(() => expect(producer.current()).toBe(false));
  const stops = [
    subscribeDocChannelNotifications(undefined, vi.fn(), owner, () => {
      throw new Error('Subscriber failure');
    }),
    subscribeDocChannelNotifications(undefined, vi.fn(), owner, later),
  ];
  try {
    expect(() => producer.retire()).not.toThrow();
    expect(later).toHaveBeenCalledOnce();
    expect(producer.publish(DOC_EVENT)).toBe(false);
    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
    controller.abort();
    expect(later).toHaveBeenCalledOnce();
  } finally {
    producer.retire();
    stops.forEach((stop) => stop());
    removed.mockRestore();
  }
});
