import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentBrowserPresetSchema } from '@dorkos/shared/agent-browser';
import { mcpBrowserCapabilities } from '../mcp-browser-capabilities.js';
import { agentBrowserMissingNotice, readAgentBrowserPreset } from '../agent-browser-preset.js';

const SECRET = 'cookie-value-that-must-not-leave';
let dorkHome: string;

beforeEach(() => {
  dorkHome = fs.mkdtempSync(path.join(tmpdir(), 'dorkos-browser-preset-'));
});
afterEach(() => {
  fs.rmSync(dorkHome, { recursive: true, force: true });
});

describe('readAgentBrowserPreset', () => {
  it('offers the isolated, session-seeded server even before anything is saved', () => {
    const preset = readAgentBrowserPreset(dorkHome);
    const stateFile = path.join(dorkHome, 'browser', 'storage-state.json');
    expect(preset).toMatchObject({ stateFile, saved: false, savedAt: null, sites: [] });
    expect(preset.loginCommand).toBe('dorkos browser login');
    expect(preset.server).toEqual({
      name: 'browser',
      connection: {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@playwright/mcp@latest', '--isolated', '--storage-state', stateFile],
        env: {},
      },
    });
    expect(AgentBrowserPresetSchema.parse(preset)).toEqual(preset);
  });

  it('reports sites and dates from the saved session, never a value', () => {
    const stateFile = path.join(dorkHome, 'browser', 'storage-state.json');
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        cookies: [
          {
            name: 'user_session',
            value: SECRET,
            domain: 'github.com',
            path: '/',
            expires: Date.parse('2027-01-01T00:00:00Z') / 1000,
            httpOnly: true,
            secure: true,
            sameSite: 'Lax',
          },
        ],
        origins: [],
      })
    );
    const preset = readAgentBrowserPreset(dorkHome, new Date('2026-09-19T00:00:00Z'));
    expect(preset.saved).toBe(true);
    expect(preset.sites).toEqual([
      {
        site: 'github.com',
        cookies: 1,
        expiresAt: '2027-01-01T00:00:00.000Z',
        expired: false,
        pageStorage: false,
      },
    ]);
    expect(JSON.stringify(preset)).not.toContain(SECRET);
  });

  it('reads an unreadable file as nothing saved, so the fix is the same login', () => {
    const stateFile = path.join(dorkHome, 'browser', 'storage-state.json');
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, 'not json');
    expect(readAgentBrowserPreset(dorkHome).saved).toBe(false);
  });
});

describe('mcp.browser_preset', () => {
  it('is a read, reachable from both MCP servers, with no tokenless carve-out', () => {
    const [capability] = mcpBrowserCapabilities;
    expect(capability!.id).toBe('mcp.browser_preset');
    expect(capability!.tier).toBe('observe');
    expect(capability!.surfaces.mcp).toMatchObject({
      toolName: 'mcp_browser_preset',
      servers: ['in-session', 'external'],
    });
    expect(capability!.surfaces.mcp?.readOnlyCarveOut).toBeUndefined();
  });
});

describe('agentBrowserMissingNotice', () => {
  it('is empty when nothing is missing', () => {
    expect(agentBrowserMissingNotice([])).toBe('');
  });
});
