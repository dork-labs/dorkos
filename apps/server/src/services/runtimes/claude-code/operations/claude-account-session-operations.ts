import { readOriginalClaudeNativePreparationView } from '../claude-code-runtime.js';
import {
  resolveLaunchAccountRoot,
  accountIdForRoot,
  type LaunchAccountResolution,
} from '../claude-config-dir.js';
import { withClaudeConfigDir } from '../claude-config-env-lock.js';
import { homeOf, readHomeManifest, resolveAgentHome } from '../../../core/agent-identity/index.js';
import { projectOfFolder } from '../../../core/usage/account-eligibility.js';
import { checkClaudeLaunchAccount } from '../launch-account-check.js';

/** Execute original accountRootForSession behavior after actual runtime private-key admission. */
export async function accountRootForSession(
  ownerKey: object,
  sessionId: string,
  projectDir: string
): Promise<string | null> {
  const facet = readOriginalClaudeNativePreparationView(ownerKey);
  const settled = await facet.sessionStore.settledAccountRoot(
    sessionId,
    facet.transcriptReader,
    projectDir
  );
  if (settled) return settled;
  const home = homeOf(resolveAgentHome(projectDir));
  const manifest = home ? await readHomeManifest(home).catch(() => null) : null;
  // Keeps to the accounts that may work in this folder's project; a launch
  // that would be refused predicts no account at all (spec
  // `flow-multiproject` §8.4).
  const launch = resolveLaunchAccountRoot({
    agentAccountId: manifest?.account,
    agentId: manifest?.id,
    project: await projectOfFolder(projectDir),
  });
  return launch.ok ? launch.root : null;
}

/** Execute original checkLaunchAccount behavior after actual runtime private-key admission. */
export async function checkLaunchAccount(
  ownerKey: object,
  sessionId: string,
  projectDir: string,
  hintId?: string
): Promise<LaunchAccountResolution> {
  const facet = readOriginalClaudeNativePreparationView(ownerKey);
  const settled = await facet.sessionStore
    .settledAccountRoot(sessionId, facet.transcriptReader, projectDir)
    .catch(() => undefined);
  if (settled) return { ok: true, root: settled, accountId: accountIdForRoot(settled) };
  return checkClaudeLaunchAccount({ cwd: projectDir, hintId });
}

/** Execute original hasSettledAccount behavior after actual runtime private-key admission. */
export async function hasSettledAccount(
  ownerKey: object,
  sessionId: string,
  projectDir: string
): Promise<boolean> {
  const facet = readOriginalClaudeNativePreparationView(ownerKey);
  const settled = await facet.sessionStore
    .settledAccountRoot(sessionId, facet.transcriptReader, projectDir)
    .catch(() => undefined);
  return settled !== undefined;
}

/** Execute original renameSession behavior after actual runtime private-key admission. */
export async function renameSession(
  ownerKey: object,
  sessionId: string,
  title: string,
  projectDir: string
): Promise<void> {
  const facet = readOriginalClaudeNativePreparationView(ownerKey);
  const { renameSession: sdkRenameSession } = await import('@anthropic-ai/claude-agent-sdk');
  // `renameSession` runs IN-PROCESS and its options expose no config dir, so
  // the env lock is the only way to point it at the session's OWN account —
  // without it a rename writes into whichever account is active, where the
  // session does not exist, and the new title silently goes nowhere (spec D8).
  const accountRoot = await facet.sessionStore.accountRootFor(
    sessionId,
    facet.transcriptReader,
    projectDir
  );
  await withClaudeConfigDir(accountRoot, () =>
    sdkRenameSession(sessionId, title, { dir: projectDir })
  );
  // The SDK persists the title; drop the reader's cache so the next read
  // re-extracts it via getSessionInfo (no in-memory title overlay).
  facet.transcriptReader.invalidate(sessionId);
}
