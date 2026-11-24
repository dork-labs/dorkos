import path from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import { permissionAsked, permissionRequest } from '../opencode-sse-fixtures.js';
import { toolTurnFixture } from './fixture.js';

it('asks before editing for one send and restores the live chat mode on the next turn', async () => {
  const f = await toolTurnFixture();
  onTestFinished(() => f.close());
  f.runtime.ensureSession('s1', { cwd: f.desk, permissionMode: 'bypassPermissions' });
  const first = await f.start({ permissionMode: 'default' });
  const nativeId = await f.nativeId();
  const filepath = path.join(f.desk, 'notes.md');
  const edit = (id: string) => {
    f.sidecar.emit(
      permissionAsked(
        permissionRequest(nativeId, {
          id,
          permission: 'edit',
          patterns: [filepath],
          metadata: { filepath },
        })
      )
    );
  };
  const reply = f.sidecar.client.postSessionIdPermissionsPermissionId;

  expect((await f.caller()).read()).toMatchObject({
    effectiveMode: 'default',
    chosenMode: 'default',
  });
  edit('first-edit');
  await vi.waitFor(() =>
    expect(first.events.filter((event) => event.type === 'approval_required')).toMatchObject([
      { data: { toolCallId: 'first-edit', toolName: 'edit', blockedPath: filepath } },
    ])
  );
  expect(reply).not.toHaveBeenCalled();
  expect(f.runtime.approveTool('s1', 'first-edit', true)).toBe(true);
  await vi.waitFor(() =>
    expect(reply).toHaveBeenCalledWith({
      path: { id: nativeId, permissionID: 'first-edit' },
      body: { response: 'once' },
    })
  );
  await f.finish();
  await first.finished;

  const next = await f.start();
  expect((await f.caller()).read()).toMatchObject({
    effectiveMode: 'bypassPermissions',
    chosenMode: 'bypassPermissions',
  });
  edit('next-edit');
  await vi.waitFor(() =>
    expect(reply).toHaveBeenCalledWith({
      path: { id: nativeId, permissionID: 'next-edit' },
      body: { response: 'once' },
    })
  );
  expect(next.events.filter((event) => event.type === 'approval_required')).toHaveLength(0);
  await f.finish();
  await next.finished;
});
