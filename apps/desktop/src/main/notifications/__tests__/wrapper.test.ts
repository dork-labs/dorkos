import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => import('../../__tests__/electron-mock'));

import { electronNotificationHost } from '../wrapper';
import {
  Notification,
  resetElectronMock,
  type MockNotification,
} from '../../__tests__/electron-mock';

beforeEach(() => {
  resetElectronMock();
});

describe('electronNotificationHost', () => {
  it('reports platform support straight from Notification.isSupported', () => {
    Notification.isSupported = vi.fn(() => false);
    expect(electronNotificationHost.isSupported()).toBe(false);
  });

  it('is always silent, so the OS banner never doubles up with the client knock sound', () => {
    electronNotificationHost.show({ title: 'Hello' });
    const [notification] = Notification.instances;
    expect(notification?.options.silent).toBe(true);
  });

  it('passes title and body through untouched', () => {
    electronNotificationHost.show({
      title: 'my-session is waiting on your answer',
      body: 'Wants to run a Bash command',
    });
    const [notification] = Notification.instances as [MockNotification];
    expect(notification.options.title).toBe('my-session is waiting on your answer');
    expect(notification.options.body).toBe('Wants to run a Bash command');
  });

  it('builds macOS button actions from the spec, in order', () => {
    electronNotificationHost.show({
      title: 'Ask',
      actions: [{ label: 'Allow' }, { label: 'Deny' }],
    });
    const [notification] = Notification.instances as [MockNotification];
    expect(notification.options.actions).toEqual([
      { type: 'button', text: 'Allow' },
      { type: 'button', text: 'Deny' },
    ]);
  });

  it('sets hasReply and replyPlaceholder from the spec', () => {
    electronNotificationHost.show({
      title: 'Ask',
      hasReply: true,
      replyPlaceholder: 'Type your answer…',
    });
    const [notification] = Notification.instances as [MockNotification];
    expect(notification.options.hasReply).toBe(true);
    expect(notification.options.replyPlaceholder).toBe('Type your answer…');
  });

  it('shows the notification', () => {
    electronNotificationHost.show({ title: 'Ask' });
    const [notification] = Notification.instances as [MockNotification];
    expect(notification.show).toHaveBeenCalledOnce();
  });

  it('routes an action click to onAction with its index', async () => {
    const onAction = vi.fn();
    electronNotificationHost.show({
      title: 'Ask',
      actions: [{ label: 'Allow' }, { label: 'Deny' }],
      onAction,
    });
    const [notification] = Notification.instances as [MockNotification];
    await notification.emitAction(1);
    expect(onAction).toHaveBeenCalledWith(1);
  });

  it('routes a reply to onReply with the typed text', async () => {
    const onReply = vi.fn();
    electronNotificationHost.show({ title: 'Ask', hasReply: true, onReply });
    const [notification] = Notification.instances as [MockNotification];
    await notification.emitReply('Blue, please');
    expect(onReply).toHaveBeenCalledWith('Blue, please');
  });

  it('routes a body click to onClick', async () => {
    const onClick = vi.fn();
    electronNotificationHost.show({ title: 'Ask', onClick });
    const [notification] = Notification.instances as [MockNotification];
    await notification.emitClick();
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('does not wire an action/reply/click listener the spec never asked for', () => {
    electronNotificationHost.show({ title: 'Just information' });
    const [notification] = Notification.instances as [MockNotification];
    expect(notification.on).not.toHaveBeenCalled();
  });

  it('close() dismisses the underlying notification', () => {
    const handle = electronNotificationHost.show({ title: 'Ask' });
    const [notification] = Notification.instances as [MockNotification];
    handle.close();
    expect(notification.close).toHaveBeenCalledOnce();
  });
});
