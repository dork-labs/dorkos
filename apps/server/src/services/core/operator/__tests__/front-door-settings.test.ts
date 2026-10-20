/**
 * The Owner-only front-door settings (DOR-2969): derived from the `reach`,
 * `credentials` and `code` stakes, so every path there is either a front-door
 * setting or exempted with a reason, and a new one fails here until classified.
 */
import { describe, expect, it } from 'vitest';

import {
  FRONT_DOOR_CONFIG_PATHS,
  FRONT_DOOR_EXEMPT,
  FRONT_DOOR_STAKE_PATHS,
  frontDoorPathsOf,
  frontDoorSubjectOf,
} from '../front-door-settings.js';
import { findOperatorOnlyPaths, OPERATOR_ONLY_CONFIG_PATHS } from '../config-write-policy.js';

describe('the front-door settings', () => {
  it.each([...FRONT_DOOR_STAKE_PATHS])('%s is front-door or exempted with a reason', (path) => {
    const exempt = FRONT_DOOR_EXEMPT[path];
    expect(FRONT_DOOR_CONFIG_PATHS.has(path) !== (exempt !== undefined)).toBe(true);
    if (exempt !== undefined) expect(exempt).toMatch(/\S.*\.$/);
  });

  it('exempts only paths the front-door stakes name', () => {
    for (const path of Object.keys(FRONT_DOOR_EXEMPT)) {
      expect(FRONT_DOOR_STAKE_PATHS).toContain(path);
    }
  });

  it.each([...FRONT_DOOR_CONFIG_PATHS])('%s is operator-only', (path) => {
    expect(OPERATOR_ONLY_CONFIG_PATHS).toContain(path);
  });

  it.each([
    'auth.enabled',
    'tunnel.authtoken',
    'server.lanAccess',
    'mcp.apiKey',
    'mcp.rateLimit.enabled',
    'mcp.rateLimit.maxPerWindow',
    'mcp.rateLimit.windowSecs',
    'spaces.official.url',
    'browser.enabled',
    'cloud.instanceToken',
    'providers',
    'runtimes.claudeCode.accounts[].path',
    'runtimes.claudeCode.defaultAccount',
    'runtimes.codex.binaryPath',
    'runtimes.opencode.binaryPath',
    'runtimes.codex.transport',
    'connectors.rawMcpServers[].url',
    'extensions.approvedToRun',
    'extensions.trustedSources[].source',
    'harness.approvedHooks',
  ])('%s is a front-door setting', (path) => {
    expect(FRONT_DOOR_CONFIG_PATHS.has(path)).toBe(true);
  });

  it.each([
    [{ auth: { enabled: false } }, ['auth.enabled']],
    [{ tunnel: { enabled: true, authtoken: 'x' } }, ['tunnel.enabled', 'tunnel.authtoken']],
    [{ server: { lanAccess: true } }, ['server.lanAccess']],
    [
      { extensions: { trustedSources: [{ source: 'a/b', trustedAt: 'now' }] } },
      ['extensions.trustedSources[].source', 'extensions.trustedSources[].trustedAt'],
    ],
  ])('finds the front-door paths in %j', (patch, expected) => {
    expect(frontDoorPathsOf(findOperatorOnlyPaths(patch)).sort()).toEqual([...expected].sort());
  });

  it('leaves operator-only settings outside the front-door stakes alone', () => {
    const paths = findOperatorOnlyPaths({
      rooms: { maxAgentDepth: 3 },
      telemetry: { usage: true },
    });
    expect(paths.length).toBeGreaterThan(0);
    expect(frontDoorPathsOf(paths)).toEqual([]);
  });

  it('names the kind of setting a refusal is about', () => {
    expect(frontDoorSubjectOf('tunnel.enabled')).toBe('who can reach DorkOS');
    expect(frontDoorSubjectOf('providers')).toBe('the accounts and keys DorkOS uses');
    expect(frontDoorSubjectOf('harness.approvedHooks')).toBe('which code DorkOS runs');
  });
});
