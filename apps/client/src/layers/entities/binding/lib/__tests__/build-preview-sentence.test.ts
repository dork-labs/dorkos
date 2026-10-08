import { describe, it, expect } from 'vitest';
import { buildPreviewSentence } from '../build-preview-sentence';

describe('buildPreviewSentence', () => {
  it('maps per-chat strategy to humanized phrase', () => {
    expect(buildPreviewSentence({ sessionStrategy: 'per-chat' })).toBe(
      'One shared chat per group or channel'
    );
  });

  it('maps per-user strategy to humanized phrase', () => {
    expect(buildPreviewSentence({ sessionStrategy: 'per-user' })).toBe('One chat for each person');
  });

  it('maps stateless strategy to humanized phrase', () => {
    expect(buildPreviewSentence({ sessionStrategy: 'stateless' })).toBe(
      'No memory between messages'
    );
  });

  it('appends chat display name with "in" when present', () => {
    expect(buildPreviewSentence({ sessionStrategy: 'per-chat', chatDisplayName: 'Dev Chat' })).toBe(
      'One shared chat per group or channel in Dev Chat'
    );
  });

  it('appends the humanized chat type with a separator when no chat name is present', () => {
    expect(buildPreviewSentence({ sessionStrategy: 'per-chat', channelType: 'group' })).toBe(
      'One shared chat per group or channel · Group'
    );
  });

  it('humanizes the bare platform "channel" kind as "Broadcast channel"', () => {
    expect(buildPreviewSentence({ sessionStrategy: 'per-chat', channelType: 'channel' })).toBe(
      'One shared chat per group or channel · Broadcast channel'
    );
  });

  it('prefers chatDisplayName over channelType when both present', () => {
    expect(
      buildPreviewSentence({
        sessionStrategy: 'per-user',
        chatDisplayName: 'General',
        channelType: 'channel',
      })
    ).toBe('One chat for each person in General');
  });
});
