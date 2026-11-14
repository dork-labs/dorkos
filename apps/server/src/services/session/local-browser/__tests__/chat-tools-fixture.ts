import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, vi } from 'vitest';
import { noopLogger } from '@dorkos/shared/logger';
import { composeRegistry } from '../../../core/capabilities/index.js';
import { createLocalBrowserDomain } from '../capabilities.js';
import { LocalBrowserService } from '../service.js';
import { chatPagesFixture } from './chat-pages-fixture.js';

const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
export async function chatToolsFixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'chat-tools-'));
  directories.push(dir);
  const fake = chatPagesFixture();
  const service = new LocalBrowserService(
    dir,
    undefined,
    fake.backend,
    undefined,
    () => ({ platform: 'darwin' }),
    undefined,
    () => ['https://app.fixture.example', 'http://localhost:9330']
  );
  service.useAgentIdentityLookup(async (sessionId) => `agent-${sessionId}`);
  service.handover.useOutsideTurnCheck(async () => false);
  await service.open({
    mode: 'new-window',
    sessionId: 'atlas',
    url: 'https://atlas.example/private?token=made-up-atlas',
  });
  await service.open({
    mode: 'new-window',
    sessionId: 'nova',
    url: 'https://nova.example/private?token=made-up-nova',
  });
  const registry = composeRegistry([createLocalBrowserDomain(service)], { logger: noopLogger });
  const call = (name: string, sessionId: string, input: unknown = {}) =>
    registry.invoke(`local_browser.${name}`, input, { sessionId });
  return { ...fake, service, dir, registry, call };
}
