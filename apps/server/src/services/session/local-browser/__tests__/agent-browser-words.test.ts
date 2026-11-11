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
import { agentBrowserNotice } from '../../../mesh/agent-browser-preset.js';
import { createLocalBrowserDomain } from '../capabilities.js';
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
