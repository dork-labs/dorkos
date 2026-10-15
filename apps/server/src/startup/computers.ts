/** Register the isolated runtime before broadcasters, without warming or booting the guest. */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { SessionAttachmentStore } from '../services/session/attachments/index.js';
import { configManager } from '../services/core/config-manager.js';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import { ComputerService } from '../services/computers/computer-service.js';
import { LimaComputerBackend } from '../services/computers/backend/lima-backend.js';
import { privateDirectory, writePrivate } from '../services/computers/backend/private-storage.js';
import { createComputerRuntime } from '../services/runtimes/opencode/computer/index.js';
import { startComputerMcpBridge } from './computer-mcp-bridge.js';
import { reportComputerStop } from './computer-stop-observation.js';
import { createComputerAgentIdentity } from './computer-agent.js';
import { logger, logError } from '../lib/logger.js';

let current: ComputerService | undefined;
let setupFailed = false;
let closeCurrent: (() => Promise<void>) | undefined;

/** Route composition reads the startup-owned singleton; no request can replace it. */
export function getComputerService(): ComputerService | undefined {
  return current;
}

/** A safe route projection can distinguish setup failure from uninitialized startup. */
export function computerSetupFailed(): boolean {
  return setupFailed;
}

/** Retain guest data and stop exactly the owned computer during server shutdown. */
export async function shutdownComputers(): Promise<void> {
  await closeCurrent?.();
}

/** Construct metadata/storage only; the default-off experiment never starts a VM on boot. */
async function composeComputerRuntime(
  dorkHome: string,
  attachments?: SessionAttachmentStore
): Promise<void> {
  const root = join(dorkHome, 'computers', 'local');
  const anchor = join(dorkHome, 'agents', 'computer-local', 'workspace');
  await privateDirectory(root);
  await privateDirectory(anchor);
  const ensureAgent = await createComputerAgentIdentity(root, anchor);
  const enabled = () => configManager.get('computers').enabled;
  const portPath = join(root, 'bridge-port');
  let port: number | undefined;
  try {
    const file = await open(portPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o777) !== 0o600 ||
        stat.size > 6
      )
        throw new Error('COMPUTER_BRIDGE_PORT_REFUSED');
      port = Number(await file.readFile('utf8'));
      if (!Number.isInteger(port) || port < 1024 || port > 65535)
        throw new Error('COMPUTER_BRIDGE_PORT_REFUSED');
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const mcpBridge = await startComputerMcpBridge({
    port,
    anchor,
    acceptingWork: () => service.acceptingWork(),
    currentGeneration: () => bridge.provider.currentGeneration(),
  });
  closeCurrent = () => mcpBridge.close();
  if (port === undefined) await writePrivate(portPath, String(mcpBridge.port));
  const service = new ComputerService({
    root,
    anchor,
    backend: new LimaComputerBackend({
      storageRoot: join(root, 'backend'),
      bridgePort: mcpBridge.port,
    }),
    enabled,
    async createSession(cwd) {
      await ensureAgent();
      const id = randomUUID();
      await runtimeRegistry.persistSessionRuntime(
        id,
        'computer-local',
        { kind: 'interactive' },
        anchor
      );
      const settings = await runtimeRegistry.getSessionSettings(id);
      bridge.runtime.ensureSession(id, {
        ...settings,
        cwd: cwd ?? anchor,
        permissionMode:
          settings?.permissionMode ??
          bridge.runtime.getCapabilities().permissionModes.default ??
          'default',
      });
      return { id, cwd, runtime: 'computer-local' };
    },
    async interruptTurns() {
      if (service.acceptingWork()) await bridge.interruptTurns();
      await bridge.revoke();
    },
    onFailure(error) {
      logger.warn('[Computer] operation failed', logError(error));
    },
  });
  const bridge = createComputerRuntime({
    runtimeId: 'computer-local',
    anchor,
    guestDirectory: '/home/agent/project',
    sessionMapPath: join(root, 'sessions.json'),
    ensureEndpoint: () => service.endpoint(),
    currentEnabled: () => service.acceptingWork(),
    attachments,
    mapMcpUrl: (url) => mcpBridge.mapUrl(url),
    onRuntimeTools: (tools) => mcpBridge.configure(tools),
  });
  bridge.runtime.setSessionSettings?.(runtimeRegistry);
  runtimeRegistry.register(bridge.runtime);
  current = service;
  const unsubscribe = configManager.onChange((change) => {
    if (!change.sections.includes('computers')) return;
    if (!enabled()) {
      void bridge
        .revoke()
        .then(() => service.stop())
        .then((status) => reportComputerStop(status, 'disable'))
        .catch(() => {
          logger.warn('[Computer] disable stop unconfirmed', {
            reason: 'disable',
            code: 'stop-threw',
          });
        });
    }
  });
  closeCurrent = async () => {
    unsubscribe();
    await bridge.revoke();
    try {
      reportComputerStop(await service.stop(), 'shutdown');
    } finally {
      await mcpBridge.close();
    }
  };
}

/** Keep existing host runtimes available when computer installation or port ownership is refused. */
export async function registerComputerRuntime(
  dorkHome: string,
  attachments?: SessionAttachmentStore
): Promise<void> {
  try {
    await composeComputerRuntime(dorkHome, attachments);
    setupFailed = false;
  } catch (error) {
    setupFailed = true;
    await closeCurrent?.().catch(() => {});
    closeCurrent = undefined;
    current = undefined;
    logger.warn('[Computer] startup refused', logError(error));
  }
}
