/**
 * Agents hear one name for the browser a person shares, and one word for that
 * person (DOR-3219, Agent awareness design pass v1 row 4).
 *
 * The area line says "Agent browser" and "person". The tools used to say
 * "DorkOS browser", "the shared browser", "the live browser" and "the operator",
 * and agents repeat what they read back to people. The notice also named
 * `relay_notify_user` bare, which no runtime can call by that name.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import type { LocalBrowserCapabilities } from '@dorkos/shared/local-browser';
import { agentBrowserNotice } from '../../../mesh/agent-browser-preset.js';
import { createLocalBrowserDomain } from '../capabilities.js';
import { assertOpenable } from '../open-input.js';
import type { LocalBrowserService } from '../service.js';

const OLD_WORDS = /DorkOS browser|shared browser|live browser|live tab|operator/i;

const capabilities = createLocalBrowserDomain({} as LocalBrowserService).capabilities;

describe('the Agent browser is named one way to agents (DOR-3219)', () => {
  it.each(capabilities.map((capability) => [capability.id, capability] as const))(
    '%s says Agent browser and person',
    (_id, capability) => {
      for (const text of [capability.title, capability.description, capability.areaNote]) {
        expect(text ?? '').not.toMatch(OLD_WORDS);
      }
      expect(`${capability.title} ${capability.description}`).toMatch(/Agent browser/);
    }
  );

  it('reads state as the page shared with this chat', () => {
    const state = capabilities.find((capability) => capability.id === 'local_browser.state');
    expect(state?.description).toContain('Read the Agent browser page shared with this chat');
  });

  it.each(['missing', 'empty'] as const)(
    'the %s notice says person, and names no tool bare',
    (gap) => {
      const notice = agentBrowserNotice(gap).replace(/\s+/g, ' ');
      expect(notice).not.toMatch(OLD_WORDS);
      expect(notice).toContain('the tool whose name ends in `relay_notify_user`');
      expect(notice.replace(/ends in `relay_notify_user`/g, '')).not.toContain('relay_notify_user');
    }
  );
});

describe('opening the Agent browser refuses in the designer’s words (DOR-3219)', () => {
  const capable: LocalBrowserCapabilities = {
    platform: 'darwin',
    managedChromiumVersion: '1.0.0',
    unavailableReasons: {},
    embedded: true,
    newWindow: true,
    playwrightVersion: '1.0.0',
    defaultMode: 'new-window',
  };

  function refusal(mode: string, hasEmbedded: boolean): string {
    try {
      assertOpenable({ mode }, hasEmbedded, capable);
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error('expected a refusal');
  }

  it('asks where to open it when the mode is unknown', () => {
    expect(refusal('tab', true)).toBe(
      'Choose where the Agent browser opens: in DorkOS or in its own window.'
    );
  });

  it('names the desktop app when DorkOS cannot hold the browser', () => {
    expect(refusal('embedded', false)).toBe(
      'Opening the Agent browser in DorkOS needs the desktop app.'
    );
  });

  it('sends a browser profile to its own window, in the panel’s words', () => {
    let message = '';
    try {
      assertOpenable({ mode: 'embedded', profileId: 'made-up' }, true, capable);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe('Open a browser profile in its own window.');
  });
});
