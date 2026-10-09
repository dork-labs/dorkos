/** Real native turn placement and authenticated original HTTP for merge controls. */
import assert from 'node:assert/strict';
import { z } from 'zod';
import { CapabilityToolError } from '../../../core/capabilities/mcp-envelope.js';
import path from 'node:path';
import request from '@dorkos/test-utils/supertest';
import { vi } from 'vitest';
import type { RoomRepoCaps } from '@dorkos/shared/room-repo';
import { RoomMergeResultSchema } from '@dorkos/shared/room-repo';
import { RoomError, type RoomErrorCode } from '../../data/room-errors.js';
import {
  initAgentIdentityService,
  resetAgentIdentityService,
} from '../../../core/agent-identity/agent-identity-service.js';
import { interactionGate } from '../../../runtimes/test-mode/interaction-gate.js';
import { peekProjector } from '../../../session/session-state-projector.js';
import { createOriginalNativeLaunchFixture } from './room-original-native-launch-fixture.js';
import { RoomWorktreeManager } from '../room-worktree-manager.js';
import { mergeNoFf, type GitIdentity } from '../room-repo-git.js';
import {
  withRecognizedInstallationRoomNamespace,
  readInstallationRoomMutationContext,
} from '../../../canvas/doc-channel/writes/installation-room-writes.js';

/** Only the native agent merge's genuine typed refusal projection, never an issuer. */
const NativeMergeRefusalSchema = z
  .object({
    code: z.enum([
      'NOT_A_PROJECT_ROOM',
      'ROOM_REPOS_DISABLED',
      'ROOM_NOT_FOUND',
      'ROOM_ARCHIVED',
      'NOTHING_TO_MERGE',
      'UNCOMMITTED_WORK',
      'BEHIND_MAIN',
      'MAIN_CHECKOUT_DIRTY',
      'SYMLINK_ESCAPES_REPO',
      'SUBMODULE_NOT_ALLOWED',
      'FILE_TOO_LARGE',
      'REPO_CAP_EXCEEDED',
      'OPERATOR_ONLY',
      'MERGE_IN_FLIGHT',
      'ROOM_REPO_CONFIG_UNSAFE',
    ]),
    error: z.string().min(1).max(8192),
  })
  .strict();

export async function createOriginalMergeTestFixture(options: {
  homeParent: string;
  caps: () => RoomRepoCaps;
}) {
  const original = await createOriginalNativeLaunchFixture({
    seed: false,
    homeParent: options.homeParent,
    operatorName: 'Dorian',
    caps: options.caps,
  });
  try {
    const targets = await original.bootNativeMergePair();
    const active = new Set<string>();
    const tokens = new Map<string, string>();
    resetAgentIdentityService();
    const identities = initAgentIdentityService(original.db);
    for (const target of targets)
      tokens.set(
        target.authorId,
        await identities.mint({
          agentPath: target.agentPath,
          displayName: original.subsystem.authors.getById(target.authorId)!.displayName,
        })
      );
    const targetFor = (authorId: string) => {
      const target = targets.find((candidate) => candidate.authorId === authorId);
      assert.ok(target, 'Actual native merge target required.');
      return target;
    };
    const announcements = () =>
      original.subsystem.service
        .listEntries(original.roomId, original.operator.id, { limit: 100 })
        .filter((entry) => entry.body.merge !== undefined)
        .map((entry) => ({
          text: entry.body.text,
          merge: entry.body.merge!,
          subjectAuthorId: entry.body.subjectAuthorId!,
        }));
    const http = (authorId: string, suffix: string, input?: object) => {
      const wire = request(original.server).post(`/api/rooms/${original.roomId}/repo${suffix}`);
      const token = tokens.get(authorId);
      if (token)
        wire.set('Authorization', `Bearer ${original.ownerKey.key}`).set('X-DorkOS-Agent', token);
      else {
        assert.ok(authorId === original.operator.id || authorId === original.member.id);
        wire.set(
          'Authorization',
          `Bearer ${
            authorId === original.operator.id ? original.ownerKey.key : original.memberKey.key
          }`
        );
      }
      return input ? wire.send(input) : wire;
    };
    const refuse = (response: { status: number; body: { code?: string; error?: string } }) => {
      if (response.status < 400) return;
      assert.ok(
        typeof response.body.code === 'string' && typeof response.body.error === 'string',
        'Actual typed Room HTTP refusal required.'
      );
      // Response attribution only; no operation/principal is constructed from this DATA.
      throw new RoomError(response.body.code as RoomErrorCode, response.body.error);
    };
    const ensure = async (authorId: string) => {
      const target = targetFor(authorId);
      if (!active.has(authorId)) {
        original.holdNativeSession(target.sessionId);
        original.subsystem.service.post(original.roomId, {
          authorId: original.operator.id,
          mentions: [authorId],
          text: 'Inspect the original Room working copy.',
        });
        await vi.waitFor(() => {
          assert.equal(interactionGate.isOpen(target.sessionId), true);
          assert.ok(
            peekProjector(target.sessionId)
              ?.replayFrom(0)
              .some((event) => event.type === 'text_delta')
          );
        });
        const prepared = original.readBoundPreparedContext(target.sessionId);
        assert.ok(prepared?.files);
        active.add(authorId);
      }
      const name = original.subsystem.authors.getById(authorId)!.displayName;
      const directory = path.join(
        original.repos.worktreesPath(original.roomId),
        RoomWorktreeManager.slugFor(name, target.agentPath)
      );
      const prepared = original.readBoundPreparedContext(target.sessionId);
      assert.equal(prepared?.files?.worktreePath, directory);
      return directory;
    };
    return {
      original,
      targets,
      announcements,
      ensure,
      enable: async () => {
        const response = await http(original.operator.id, '');
        if (response.status === 409 && response.body.code === 'ROOM_REPO_EXISTS')
          return { created: false, repo: response.body.repo };
        refuse(response);
        assert.equal(response.status, 201);
        return { created: true, repo: response.body.repo };
      },
      refusedHttpMerge: async (authorId: string, input: { summary: string; worktree?: string }) => {
        const response = await http(authorId, '/merge', input);
        refuse(response);
        assert.equal(response.status, 200);
        return RoomMergeResultSchema.parse(response.body);
      },
      merge: async (authorId: string, input: { summary: string; worktree?: string }) => {
        if (
          input.worktree === undefined &&
          active.has(authorId) &&
          !original.subsystem.service.getRoom(original.roomId, original.operator.id)?.archived
        ) {
          try {
            return await original.mergeNative(targetFor(authorId).sessionId, input.summary);
          } catch (cause) {
            if (!(cause instanceof CapabilityToolError)) throw cause;
            const refusal = NativeMergeRefusalSchema.safeParse(cause.payload);
            if (!refusal.success) throw cause;
            // Assertion DATA adapter, analogous to refuse(response) above.
            // This is not the product's caught RoomError or a source of authority.
            throw new RoomError(refusal.data.code, refusal.data.error);
          }
        }
        // Business gates and an unstarted target are exercised by the actual
        // owner choosing that agent's branch. A token is used only for the
        // separately named foreign-selector refusal, never as a producer.
        const target = targets.find((candidate) => candidate.authorId === authorId);
        const requestAuthor =
          target && input.worktree === undefined ? original.operator.id : authorId;
        const body =
          target && input.worktree === undefined
            ? {
                ...input,
                worktree: RoomWorktreeManager.slugFor(
                  original.subsystem.authors.getById(authorId)!.displayName,
                  target.agentPath
                ),
              }
            : input;
        const response = await http(requestAuthor, '/merge', body);
        refuse(response);
        assert.equal(response.status, 200);
        return RoomMergeResultSchema.parse(response.body);
      },
      mergeNoFf: (
        checkout: string,
        branch: string,
        message: string,
        identity: GitIdentity,
        ceiling: string
      ) =>
        withRecognizedInstallationRoomNamespace(original.writer, original.roomId, (scope) =>
          mergeNoFf(
            checkout,
            branch,
            message,
            identity,
            ceiling,
            readInstallationRoomMutationContext(original.writer, original.roomId, scope)
          )
        ),
      close: async () => {
        let failed = false,
          cause: unknown;
        try {
          await original.close();
        } catch (error) {
          failed = true;
          cause = error;
        }
        try {
          resetAgentIdentityService();
        } catch (error) {
          if (!failed) {
            failed = true;
            cause = error;
          }
        }
        if (failed) throw cause;
      },
    };
  } catch (cause) {
    try {
      await original.close();
    } catch {
      /* Original acquired setup cause remains first. */
    }
    try {
      resetAgentIdentityService();
    } catch {
      /* Same first cause, including undefined. */
    }
    throw cause;
  }
}
