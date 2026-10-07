import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDb, runMigrations } from '@dorkos/db';
import { WorkspaceSchema } from '@dorkos/shared/workspace';
import { createAuth } from '../../../core/auth/index.js';
import { initConfigManager } from '../../../core/config-manager.js';
import { WorkspaceStore } from '../../../workspace/workspace-store.js';
import {
  PublicNativeInputSchema,
  verifyPublicNativeEmits,
  type PublicNativeInput,
} from './public-native-input.js';
/** Files/auth/workspace-only setup AFTER a genuine exclusive-home installer/native prerequisite.
 * It never installs a browser, supplies grants/proof/runtime callbacks or enters native startup.
 * Actual HTTP campaign signs in against this real BetterAuth account and actual file-first workspace.
 * Caller invokes only once before launching the sole actual installed server for this home.
 */
export async function preparePublicNativeInput(
  input: PublicNativeInput,
  destination: string
): Promise<void> {
  const originals: {
    setup?: Promise<void>;
    signup?: Promise<Response>;
    workspace?: Promise<void>;
    db?: ReturnType<typeof createDb>;
    close?: Promise<void>;
  } = {};
  let closed = false,
    first: { value: unknown } | undefined;
  const guard = () => {
    if (closed) throw new Error('PUBLIC_NATIVE_PREPARER_CLOSED');
  };
  const close = () => {
    closed = true;
    return (originals.close ??= Promise.resolve().then(async () => {
      const results = await Promise.allSettled([
        ...(originals.setup ? [originals.setup] : []),
        ...(originals.signup ? [originals.signup] : []),
        ...(originals.workspace ? [originals.workspace] : []),
      ]);
      for (const result of results)
        if (result.status === 'rejected') first ??= { value: result.reason };
      try {
        originals.db?.$client.close();
      } catch (value) {
        first ??= { value };
      }
      if (first) throw first.value;
    }));
  };
  originals.setup = Promise.resolve().then(async () => {
    guard();
    const original = PublicNativeInputSchema.parse(input),
      home = await realpath(original.home);
    guard();
    if (
      home !== original.home ||
      !home.split('/').at(-1)?.startsWith('public-native-') ||
      !home.includes('/T/')
    )
      throw new Error('PUBLIC_NATIVE_EXCLUSIVE_HOME_REQUIRED');
    await verifyPublicNativeEmits(original, guard);
    guard();
    // The genuine owner-creation hook reads this original singleton when seeding
    // legacy MCP keys. Initialize the same exclusive home's owner before createAuth.
    const config = initConfigManager(home);
    if (config.get('browser').enabled) throw new Error('PUBLIC_NATIVE_STARTS_OFF_REQUIRED');
    config.set('auth', { enabled: true });
    guard();
    originals.db = createDb(join(home, 'dork.db'));
    runMigrations(originals.db);
    guard();
    const auth = createAuth(originals.db, home);
    guard();
    originals.signup = auth.api.signUpEmail({
      body: {
        name: 'Public native fixture owner',
        email: original.email,
        password: original.password,
      },
      asResponse: true,
    });
    const signup = await originals.signup;
    guard();
    if (signup.status !== 200) throw new Error('PUBLIC_NATIVE_ORIGINAL_ACCOUNT_SETUP_REFUSED');
    await signup.arrayBuffer();
    guard();
    const root = join(home, 'workspaces'),
      store = new WorkspaceStore(originals.db, root),
      path = store.checkoutPath('public-native', 'owned');
    await mkdir(path, { recursive: true });
    guard();
    const at = new Date().toISOString();
    const workspace = WorkspaceSchema.parse({
      id: original.workspaceId,
      projectKey: 'public-native',
      key: 'owned',
      path,
      source: path,
      branch: null,
      provider: 'clone',
      status: 'ready',
      portBase: 6400,
      portBlockSize: 10,
      hostname: null,
      url: null,
      pinned: false,
      owner: null,
      createdAt: at,
      lastUsedAt: at,
    });
    originals.workspace = store.write(workspace);
    await originals.workspace;
    guard();
    if (!store.getByKey('public-native', 'owned'))
      throw new Error('PUBLIC_NATIVE_ORIGINAL_WORKSPACE_MISSING');
    // Immutable invocation data only; no ready/actor/owned-controller/native proof fields.
    await writeFile(destination, JSON.stringify(original, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    guard();
  });
  void originals.setup.catch((value) => {
    first ??= { value };
  });
  try {
    await originals.setup;
  } finally {
    await close();
  }
}
