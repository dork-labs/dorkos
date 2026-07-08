import { describe, it, expect } from 'vitest';
import { buildPreviewSentence } from '../build-preview-sentence';

describe('buildPreviewSentence', () => {
  it('maps per-chat strategy to humanized phrase', () => {
    expect(buildPreviewSentence({ sessionStrategy: 'per-chat' })).toBe(
      'One thread for each conversation'
    );
  });

  it('maps per-user strategy to humanized phrase', () => {
    expect(buildPreviewSentence({ sessionStrategy: 'per-user' })).toBe(
      'One thread for each person'
    );
  });

  it('maps stateless strategy to humanized phrase', () => {
    expect(buildPreviewSentence({ sessionStrategy: 'stateless' })).toBe(
      'No memory between messages'
    );
  });

  it('appends chat display name with "in" when present', () => {
    expect(buildPreviewSentence({ sessionStrategy: 'per-chat', chatDisplayName: 'Dev Chat' })).toBe(
      'One thread for each conversation in Dev Chat'
    );
  });

  it('appends channel type with separator when no chat name is present', () => {
    expect(buildPreviewSentence({ sessionStrategy: 'per-chat', channelType: 'group' })).toBe(
      'One thread for each conversation · group'
    );
  });

  it('prefers chatDisplayName over channelType when both present', () => {
    expect(
      buildPreviewSentence({
        sessionStrategy: 'per-user',
        chatDisplayName: 'General',
        channelType: 'channel',
      })
    ).toBe('One thread for each person in General');
  });
});
