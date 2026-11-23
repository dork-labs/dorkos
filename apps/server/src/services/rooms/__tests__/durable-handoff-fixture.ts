/** Test-only real recorded public sources for pre-durability timing/lifecycle fixtures. */
import type { RoomHarness } from './room-test-harness.js';
/** Each timing fixture owns its actual DB/install and explicitly simulates a Full source turn. */
export async function recordFixturePublicSource(
  harness: RoomHarness,
  sessionId: string,
  agentPath: string,
  roomId: string
) {
  const db = await import('@dorkos/db');
  if (
    harness.store.getRoomSession(
      roomId,
      harness.authors.resolveAgent(agentPath, agentPath.split('/').pop()!).id
    ) === sessionId
  )
    return;
  const at = new Date().toISOString();
  harness.db
    .insert(db.agents)
    .values({
      id: agentPath,
      name: agentPath.split('/').pop()!,
      runtime: 'claude-code',
      projectPath: agentPath,
      registeredAt: at,
      updatedAt: at,
    })
    .onConflictDoNothing()
    .run();
  harness.authors.resolveAgent(agentPath, agentPath.split('/').pop()!);
  harness.db
    .insert(db.sessionMetadata)
    .values({
      sessionId,
      runtime: 'claude-code',
      agentPath,
      launchOrigin: harness.store.sessionLedger.bindingForSession(sessionId)
        ? 'room'
        : 'interactive',
      createdAt: at,
    })
    .onConflictDoNothing()
    .run();
  const levels = await import('../../core/turn-power/turn-levels.js');
  // A scenario may already have recorded a real Careful or marked turn. Keep that evidence.
  if (levels.lastTurnLevelOf(sessionId) !== undefined) return;
  const { CLAUDE_CODE_CAPABILITIES } =
    await import('../../runtimes/claude-code/runtime-constants.js');
  const { FakeAgentRuntime } = await import('@dorkos/test-utils');
  const fake = new FakeAgentRuntime('claude-code');
  fake.getCapabilities.mockReturnValue(CLAUDE_CODE_CAPABILITIES);
  const runtime = levels.recordTurnLevels(fake, () => 'bypassPermissions');
  for await (const event of runtime.sendMessage(sessionId, 'Full source fixture')) void event;
}
