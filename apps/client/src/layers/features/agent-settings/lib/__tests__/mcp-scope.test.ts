import { describe, it, expect } from 'vitest';
import type { McpServerEntry } from '@dorkos/shared/transport';
import {
  deriveDiscoveredScope,
  parseMcpServerName,
  scopeSentence,
  scopeTooltip,
} from '../mcp-scope';

/** A roster entry with only the fields the scope rules read. */
function entry(overrides: Partial<McpServerEntry> = {}): McpServerEntry {
  return { name: 'server', type: 'stdio', ...overrides };
}

describe('parseMcpServerName', () => {
  it('splits Claude Code’s plugin: prefix into a clean name and a plugin', () => {
    expect(parseMcpServerName('plugin:context7')).toEqual({
      displayName: 'context7',
      pluginName: 'context7',
      rawName: 'plugin:context7',
    });
  });

  it('reads the three-part plugin:<plugin>:<server> form as plugin then server', () => {
    expect(parseMcpServerName('plugin:playwright:browser')).toEqual({
      displayName: 'browser',
      pluginName: 'playwright',
      rawName: 'plugin:playwright:browser',
    });
  });

  it('does NOT read an @ inside an ordinary name as a plugin', () => {
    // A `<server>@<plugin>` rule was written and removed: `@` is legal inside a
    // plain server name, so the rule renamed `notion@v2` to `notion` and invented
    // a "v2 plugin" — and, because a parsed plugin outranks the runtime's own
    // scope, it also overrode a scope the runtime had actually reported. A
    // convention gets a row only once a live build is seen writing it.
    expect(parseMcpServerName('notion@v2')).toEqual({
      displayName: 'notion@v2',
      pluginName: null,
      rawName: 'notion@v2',
    });
  });

  it('falls through to the raw name when nothing matches, with no plugin', () => {
    // The fall-through is the guarantee: a surface that guessed would rename a
    // server its owner then cannot find. `my-server` looks nothing like any known
    // convention, so it comes back untouched.
    expect(parseMcpServerName('my-server')).toEqual({
      displayName: 'my-server',
      pluginName: null,
      rawName: 'my-server',
    });
  });

  it('does not invent a plugin from an empty capture', () => {
    // `plugin:` alone has nothing after the colon. Returning `{ pluginName: '' }`
    // would put an empty plugin badge and a "Comes with the  plugin" sentence on
    // the card.
    expect(parseMcpServerName('plugin:')).toEqual({
      displayName: 'plugin:',
      pluginName: null,
      rawName: 'plugin:',
    });
  });
});

describe('deriveDiscoveredScope', () => {
  it('lets a parsed plugin win over the runtime’s own scope', () => {
    const parsed = parseMcpServerName('plugin:context7');
    // The runtime says this came from the project's config, and it did — but a
    // plugin's server belongs to the plugin wherever the config that loads it
    // happens to live, and "plugin" is the fact a person can act on.
    expect(deriveDiscoveredScope(entry({ scope: 'project' }), parsed)).toBe('plugin');
  });

  it('reads both project-shaped scopes as this project', () => {
    const parsed = parseMcpServerName('shadcn');
    expect(deriveDiscoveredScope(entry({ scope: 'project' }), parsed)).toBe('project');
    expect(deriveDiscoveredScope(entry({ scope: 'local' }), parsed)).toBe('project');
  });

  it('reads a user scope as the computer-wide config', () => {
    expect(deriveDiscoveredScope(entry({ scope: 'user' }), parseMcpServerName('shadcn'))).toBe(
      'computer'
    );
  });

  it('answers null — not "computer" — when the runtime did not say', () => {
    // Defaulting to `computer` was a guess printed as a fact. It told people a
    // server their own project declares came from their computer-wide config, and
    // it would have mislabelled EVERY server from a runtime that reports no scope
    // at all (OpenCode). Null means the card shows no badge.
    const parsed = parseMcpServerName('shadcn');
    expect(deriveDiscoveredScope(entry(), parsed)).toBeNull();
    expect(deriveDiscoveredScope(entry({ scope: 'dynamic' }), parsed)).toBeNull();
  });

  it('does not let an @ in a name manufacture a plugin that outranks a real scope', () => {
    // The two halves of the dropped rule's damage, together: the name survives
    // intact AND the runtime's own project scope still wins.
    const parsed = parseMcpServerName('notion@v2');
    expect(deriveDiscoveredScope(entry({ scope: 'project' }), parsed)).toBe('project');
  });
});

describe('scope copy', () => {
  it('names the plugin in both the tooltip and the sentence when one is known', () => {
    expect(scopeTooltip('plugin', 'Context7')).toBe('Comes with the Context7 plugin');
    expect(scopeSentence('plugin', 'Context7')).toBe(
      'Comes with the Context7 plugin. Add it to manage it here.'
    );
  });

  it('degrades to a plugin-less sentence rather than a blank when the plugin is unknown', () => {
    expect(scopeTooltip('plugin', null)).toBe('Comes with a plugin');
    expect(scopeSentence('plugin', null)).toBe('Comes with a plugin. Add it to manage it here.');
  });

  it('claims no origin at all for an unknown scope', () => {
    expect(scopeSentence(null, null)).toBe(
      'This agent’s runtime loads this server. Add it to manage it here.'
    );
  });
});
