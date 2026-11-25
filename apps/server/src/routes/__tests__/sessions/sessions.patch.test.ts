/**
 * `PATCH /api/sessions/:id`: the permission-mode and model gates, and the
 * shape of what a settings change answers.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ModelOption, PermissionModeId } from '@dorkos/shared/types';
import type { FakeAgentRuntime } from '@dorkos/test-utils';

vi.mock('../../../services/core/runtime-registry.js', async () =>
  (await import('./sessions.fixtures.js')).registryModule()
);
vi.mock('../../../lib/boundary.js', async (importOriginal) =>
  (await import('./sessions.fixtures.js')).boundaryModule(await importOriginal<object>())
);

import { listeningServer } from '@dorkos/test-utils/listening-server';
import request from '@dorkos/test-utils/supertest';
import { MainRequestAdmission } from '../../../services/core/lifecycle/main-request-admission.js';
import { composedListener } from '../../../http/__tests__/composed-listener.js';
import { initBoundary } from '../../../lib/boundary.js';
import { initConfigManager } from '../../../services/core/config-manager.js';
import { runtimeRegistry } from '../../../services/core/runtime-registry.js';
import { disposeProjector } from '../../../services/session/session-state-projector.js';
// The real profile of the one shipped runtime whose mode ids sit outside the
// shared enum (DOR-811).
import { TEST_MODE_CAPABILITIES } from '../../../services/runtimes/test-mode/runtime-constants.js';
import { S1, runtimeHolder, useSessionsApp } from './sessions.fixtures.js';

const server = listeningServer(composedListener(new MainRequestAdmission(), { sessions: {} }));

useSessionsApp({ runtimeRegistry, disposeProjector, initBoundary, initConfigManager });

let fakeRuntime: FakeAgentRuntime;
beforeEach(() => {
  fakeRuntime = runtimeHolder.current;
  fakeRuntime.updateSession.mockReturnValue({ updated: true });
});

/** What `updateSession` receives for a PATCH carrying only these fields. */
function forwarded(fields: { permissionMode?: string; model?: string }) {
  return {
    permissionMode: undefined,
    model: undefined,
    effort: undefined,
    fastMode: undefined,
    ...fields,
  };
}

/**
 * Narrow the runtime's declared permission modes for one test, so the
 * capability gate is exercised against a realistic runtime posture (the
 * shared FakeAgentRuntime declares all six modes).
 */
function declareModes(ids: PermissionModeId[]): void {
  const capabilities = fakeRuntime.getCapabilities();
  fakeRuntime.getCapabilities.mockReturnValue({
    ...capabilities,
    permissionModes: {
      supported: true,
      default: ids[0],
      values: capabilities.permissionModes.values.filter((d) => ids.includes(d.id)),
    },
  });
  fakeRuntime.getCapabilities.mockClear();
}

describe('PATCH /api/sessions/:id', () => {
  it('returns 200 when permission mode update succeeds', async () => {
    fakeRuntime.getSession.mockResolvedValue({
      id: S1,
      title: 'Test session',
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
      permissionMode: 'dontAsk',
      runtime: 'fake',
    });

    const res = await request(server)
      .patch(`/api/sessions/${S1}`)
      .send({ permissionMode: 'dontAsk' });

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('permissionModePendingUntilNextTurn');
    expect(fakeRuntime.updateSession).toHaveBeenCalledWith(
      S1,
      forwarded({ permissionMode: 'dontAsk' })
    );
  });

  // A tightening the running reply never heard about (DOR-1435): answering
  // `200 {permissionMode:'default'}` would state a safety posture the agent
  // has not adopted.
  it('answers 202 and says so when a stricter mode did not reach the running reply', async () => {
    fakeRuntime.updateSession.mockReturnValue({
      updated: true,
      permissionModePendingUntilNextTurn: true,
    });
    fakeRuntime.getSession.mockResolvedValue({
      id: S1,
      title: 'Test session',
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
      permissionMode: 'default',
      runtime: 'fake',
    });

    const res = await request(server)
      .patch(`/api/sessions/${S1}`)
      .send({ permissionMode: 'default' });

    expect(res.status).toBe(202);
    expect(res.body.permissionModePendingUntilNextTurn).toBe(true);
    expect(res.body.permissionMode).toBe('default');
  });

  it.each([
    // Codex declares no `auto`: a session PATCHed to auto would display
    // "Auto" while the runtime kept running read-only.
    { runtimeModes: ['default', 'acceptEdits', 'bypassPermissions'], asked: 'auto' },
    // Claude Code declares no `dontAsk`.
    {
      runtimeModes: ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto'],
      asked: 'dontAsk',
    },
  ] as { runtimeModes: PermissionModeId[]; asked: PermissionModeId }[])(
    'returns 400 for a permission mode the runtime does not declare ($asked)',
    async ({ runtimeModes, asked }) => {
      declareModes(runtimeModes);

      const res = await request(server)
        .patch(`/api/sessions/${S1}`)
        .send({ permissionMode: asked });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_request');
      // The message must name the runtime and the modes it CAN run.
      expect(res.body.detail).toContain('fake');
      expect(res.body.detail).toContain(asked);
      for (const mode of runtimeModes) expect(res.body.detail).toContain(mode);
      expect(fakeRuntime.updateSession).not.toHaveBeenCalled();
    }
  );

  it('returns 200 for every mode the runtime does declare', async () => {
    declareModes(['default', 'acceptEdits', 'bypassPermissions']);

    for (const mode of ['default', 'acceptEdits', 'bypassPermissions'] as const) {
      const res = await request(server).patch(`/api/sessions/${S1}`).send({ permissionMode: mode });
      expect(res.status).toBe(200);
    }
  });

  // A runtime names its own modes, and `test-mode` names all three outside
  // the shared enum on purpose (DOR-811). Its REAL descriptors are used.
  describe('a runtime whose mode ids are outside the shared enum', () => {
    beforeEach(() => {
      fakeRuntime.getCapabilities.mockReturnValue(TEST_MODE_CAPABILITIES);
      fakeRuntime.getCapabilities.mockClear();
    });

    it('accepts every mode that runtime declares, its autonomy stop with nothing to acknowledge', async () => {
      expect(
        TEST_MODE_CAPABILITIES.permissionModes.values.some((d) => d.stop === 'autonomy'),
        'test-mode declares no autonomy stop'
      ).toBe(true);
      for (const descriptor of TEST_MODE_CAPABILITIES.permissionModes.values) {
        fakeRuntime.updateSession.mockClear();
        const res = await request(server)
          .patch(`/api/sessions/${S1}`)
          .send({ permissionMode: descriptor.id });

        expect(res.status, `PATCH to declared mode '${descriptor.id}'`).toBe(200);
        expect(fakeRuntime.updateSession).toHaveBeenCalledWith(
          S1,
          forwarded({ permissionMode: descriptor.id })
        );
      }
    });

    it.each([
      // A shared-enum member this runtime does NOT declare.
      'acceptEdits',
      // An id no runtime anywhere declares.
      'totally-made-up',
    ])('still refuses an undeclared mode (%s)', async (asked) => {
      const res = await request(server)
        .patch(`/api/sessions/${S1}`)
        .send({ permissionMode: asked });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_request');
      expect(fakeRuntime.updateSession).not.toHaveBeenCalled();
    });
  });

  // Full autonomy is a choice like any other (DOR-2739): the consent door is
  // retired (ADR 261006-225605), so an acknowledgement an older client still
  // sends is ignored and never forwarded.
  it('saves a mode that never asks, ignoring an old acknowledgement field', async () => {
    const descriptor = fakeRuntime
      .getCapabilities()
      .permissionModes.values.find((d) => d.stop === 'autonomy');
    expect(descriptor, 'the fake runtime declares no autonomy stop').toBeDefined();
    fakeRuntime.getCapabilities.mockClear();

    const res = await request(server)
      .patch(`/api/sessions/${S1}`)
      .send({ permissionMode: descriptor!.id, acknowledgedAutonomy: false });

    expect(res.status).toBe(200);
    expect(fakeRuntime.updateSession).toHaveBeenCalledWith(
      S1,
      forwarded({ permissionMode: descriptor!.id })
    );
  });

  it('leaves non-mode settings unaffected by the permission-mode gate', async () => {
    // The model rides through because the fake offers no catalog, which the
    // model gate reads as "cannot answer".
    declareModes(['default']);

    const res = await request(server).patch(`/api/sessions/${S1}`).send({ model: 'some-model' });

    expect(res.status).toBe(200);
    expect(fakeRuntime.updateSession).toHaveBeenCalledWith(S1, forwarded({ model: 'some-model' }));
  });

  // The model gate (DOR-1660): only the runtime can say whether a model id is
  // real, and one it cannot run fails LATER, after the person has typed.
  describe('the model gate', () => {
    /** Point the fake's catalog at a fixed set of offered models. */
    function offerModels(options: ModelOption[]): void {
      fakeRuntime.getSupportedModels.mockResolvedValue(options);
    }

    it('returns 400 for a model the runtime does not offer', async () => {
      offerModels([
        { value: 'openrouter/anthropic/claude-opus-5', displayName: 'Opus 5', description: '' },
      ]);

      const res = await request(server)
        .patch(`/api/sessions/${S1}`)
        .send({ model: 'openrouter/anthropic/claude-opus-5-fast' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_request');
      expect(res.body.detail).toContain('fake');
      expect(res.body.detail).toContain('openrouter/anthropic/claude-opus-5-fast');
      expect(fakeRuntime.updateSession).not.toHaveBeenCalled();
    });

    it('accepts every model the runtime does offer, and the wire id an alias resolves to', async () => {
      offerModels([
        { value: 'openrouter/anthropic/claude-opus-5', displayName: 'Opus 5', description: '' },
        { value: 'ollama/qwen2.5-coder:7b', displayName: 'Qwen', description: '' },
        // A session may have persisted the wire id the alias expands to.
        {
          value: 'sonnet',
          resolvedModel: 'claude-sonnet-5',
          displayName: 'Sonnet',
          description: '',
        },
      ]);

      for (const model of [
        'openrouter/anthropic/claude-opus-5',
        'ollama/qwen2.5-coder:7b',
        'claude-sonnet-5',
      ]) {
        fakeRuntime.updateSession.mockClear();
        const res = await request(server).patch(`/api/sessions/${S1}`).send({ model });
        expect(res.status, `PATCH to offered model '${model}'`).toBe(200);
        expect(fakeRuntime.updateSession).toHaveBeenCalledWith(S1, forwarded({ model }));
      }
    });

    it.each([
      // An unreachable OpenCode sidecar, a timed-out warm-up, or test-mode all
      // answer `[]`; refusing on that would turn a probe failure into a lock.
      ['the catalog is empty', () => fakeRuntime.getSupportedModels.mockResolvedValue([])],
      [
        'the catalog probe throws',
        () => fakeRuntime.getSupportedModels.mockRejectedValue(new Error('sidecar down')),
      ],
    ])('accepts anything when %s', async (_case, arrange) => {
      arrange();
      const res = await request(server)
        .patch(`/api/sessions/${S1}`)
        .send({ model: 'anything/at-all' });
      expect(res.status).toBe(200);
    });

    it('never consults the catalog when the PATCH carries no model', async () => {
      offerModels([{ value: 'only-this', displayName: 'Only', description: '' }]);

      const res = await request(server)
        .patch(`/api/sessions/${S1}`)
        .send({ permissionMode: 'plan' });

      expect(res.status).toBe(200);
      expect(fakeRuntime.getSupportedModels).not.toHaveBeenCalled();
    });
  });

  // ADR-0261: updateSession is contractually no-throw; the best-effort
  // behavior is unit-tested in session-store-update.test.ts.

  it('includes the resolved runtime in the fallback body when getSession returns null', async () => {
    // Session.runtime is required on the wire (task 1.1).
    const res = await request(server).patch(`/api/sessions/${S1}`).send({ permissionMode: 'plan' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: S1, permissionMode: 'plan', runtime: 'fake' });
  });

  it('returns 404 when session does not exist', async () => {
    fakeRuntime.updateSession.mockReturnValue({ updated: false });

    const res = await request(server).patch(`/api/sessions/${S1}`).send({ permissionMode: 'plan' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('session_not_found');
  });

  it('returns 400 for invalid session ID', async () => {
    const res = await request(server)
      .patch('/api/sessions/not-a-uuid')
      .send({ permissionMode: 'plan' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_request');
  });

  it.each([
    { body: { permissionMode: 42 }, why: 'a non-string mode' },
    { body: { permissionMode: '' }, why: 'an empty mode id' },
    { body: { permissionMode: '-leading-dash' }, why: 'a malformed mode id' },
    { body: { permissionMode: 'x'.repeat(65) }, why: 'an over-long mode id' },
    { body: { title: '' }, why: 'an empty title' },
  ])('returns 400 for invalid request body ($why)', async ({ body }) => {
    // Only shape is checked here; a well-formed but undeclared id is the
    // capability gate's `UNSUPPORTED_PERMISSION_MODE` (DOR-811).
    const res = await request(server).patch(`/api/sessions/${S1}`).send(body);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_request');
    expect(fakeRuntime.updateSession).not.toHaveBeenCalled();
  });

  it('translates session ID via getInternalSessionId', async () => {
    const internalId = '00000000-0000-4000-8000-internal00001';
    fakeRuntime.getInternalSessionId.mockReturnValue(internalId);

    await request(server).patch(`/api/sessions/${S1}`).send({ permissionMode: 'plan' });

    expect(fakeRuntime.updateSession).toHaveBeenCalledWith(
      internalId,
      expect.objectContaining({ permissionMode: 'plan' })
    );
  });
});
