import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  env: { NODE_ENV: 'development', CLIENT_DIST_PATH: undefined as string | undefined },
  agentComputer: false,
}));
vi.mock('../../env.js', () => ({ env: state.env }));
vi.mock('../../services/core/server-role/role-checks.js', () => ({
  isAgentComputer: () => state.agentComputer,
}));
import { clientDistPath } from '../client-dist.js';

beforeEach(() => {
  state.env.NODE_ENV = 'development';
  state.env.CLIENT_DIST_PATH = undefined;
  state.agentComputer = false;
});

describe('the build served by the HTTP server', () => {
  it('honors the explicit preview build without changing the development data mode', () => {
    state.env.CLIENT_DIST_PATH = '/preview/dist/renderer';
    expect(clientDistPath()).toBe('/preview/dist/renderer');
    expect(state.env.NODE_ENV).toBe('development');
  });

  it('leaves ordinary development to Vite', () => {
    expect(clientDistPath()).toBeUndefined();
  });

  it('uses the explicit production build', () => {
    state.env.NODE_ENV = 'production';
    state.env.CLIENT_DIST_PATH = '/packaged/dist/renderer';
    expect(clientDistPath()).toBe('/packaged/dist/renderer');
  });

  it('finds the default build only in production', () => {
    state.env.NODE_ENV = 'production';
    expect(clientDistPath()).toMatch(/client[/\\]dist$/);
  });

  it.each(['development', 'production'])('never serves a UI on an agent computer in %s', (mode) => {
    state.env.NODE_ENV = mode;
    state.env.CLIENT_DIST_PATH = '/preview/dist/renderer';
    state.agentComputer = true;
    expect(clientDistPath()).toBeUndefined();
  });
});
