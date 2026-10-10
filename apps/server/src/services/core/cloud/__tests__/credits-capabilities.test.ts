import { describe, expect, it } from 'vitest';
import type { RuntimeCapabilities, RuntimeCreditsProtocol } from '@dorkos/shared/agent-runtime';
import { creditsCapabilitiesFor, CreditsUnavailableError } from '../credits-protocols.js';

const protocols: RuntimeCreditsProtocol[] = [
  'anthropic-messages',
  'openai-chat-completions',
  'openai-responses',
];
const capabilities = {
  type: 'doe',
  credits: { protocol: 'anthropic-messages', supportedProtocols: protocols, scope: 'conversation' },
} as unknown as RuntimeCapabilities;

describe('creditsCapabilitiesFor', () => {
  it('preserves existing single-format runtime declarations by identity', () => {
    const declared = {
      type: 'codex',
      credits: { protocol: 'openai-responses', scope: 'conversation' },
    } as unknown as RuntimeCapabilities;
    expect(creditsCapabilitiesFor({ getCapabilities: () => declared }, 'existing')).toBe(declared);
  });

  it.each(protocols)(
    'selects the frozen %s format without mutating the declaration',
    (protocol) => {
      const runtime = {
        getCapabilities: () => capabilities,
        getCreditsProtocol: (id?: string) =>
          id === 'frozen' ? protocol : ('anthropic-messages' as const),
      };
      expect(creditsCapabilitiesFor(runtime, 'frozen').credits).toEqual({
        protocol,
        supportedProtocols: [protocol],
        scope: 'conversation',
      });
      expect(creditsCapabilitiesFor(runtime).credits?.protocol).toBe('anthropic-messages');
      expect(capabilities.credits?.supportedProtocols).toEqual(protocols);
      expect(capabilities.credits?.protocol).toBe('anthropic-messages');
    }
  );

  it('refuses a protocol outside the runtime declaration', () => {
    expect(() =>
      creditsCapabilitiesFor({
        getCapabilities: () =>
          ({
            type: 'codex',
            credits: { protocol: 'openai-responses', scope: 'conversation' },
          }) as RuntimeCapabilities,
        getCreditsProtocol: () => 'openai-chat-completions',
      })
    ).toThrow(CreditsUnavailableError);
  });
});
