/** Browser-safe remote room operations routed exclusively through the local server. */
import {
  RemoteCommunityRoomsResponseSchema,
  RemoteCommunityRoomResponseSchema,
  RemoteCommunityHistoryQuerySchema,
  RemoteCommunityHistoryResponseSchema,
  RemoteCommunityPostRequestSchema,
  RemoteCommunityPostResponseSchema,
  RemoteCommunityMembersResponseSchema,
  RemoteCommunityReadCursorSchema,
  RemoteCommunityEnrollRequestSchema,
  RemoteCommunityEnrollmentsResponseSchema,
  RemoteCommunityEnrollmentResponseSchema,
  RemoteCommunityEjectionResponseSchema,
  RemoteCommunityAttachmentResponseSchema,
  type RemoteCommunityTransport,
} from '@dorkos/shared/community-views';
import { CommunityDeliverySnapshotSchema } from '@dorkos/shared/community-deliveries';
import { HaltRoomResponseSchema } from '@dorkos/shared/room-schemas';
import { fetchJSON, fetchNoContent, fetchResponse, buildQueryString } from './http-client';
import { createRemoteCommunityStream } from './remote-community-stream';

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const communityPath = (ref: string) => `/communities/${encodeURIComponent(ref)}`;
const roomPath = (ref: string, id: string) =>
  `${communityPath(ref)}/rooms/${encodeURIComponent(id)}`;
const agentPath = (ref: string, id: string) =>
  `${communityPath(ref)}/agents/${encodeURIComponent(id)}`;

function qualified<T extends { community: string; roomId?: string }>(
  value: T,
  ref: string,
  roomId?: string
): T {
  if (value.community !== ref || (roomId !== undefined && value.roomId !== roomId)) {
    throw new Error('The community returned data for a different room.');
  }
  return value;
}

/** Create native community methods without exposing remote credentials or URLs to feature code. */
export function createRemoteCommunityMethods(baseUrl: string): RemoteCommunityTransport {
  return {
    async listRemoteCommunityRooms(ref) {
      return qualified(
        RemoteCommunityRoomsResponseSchema.parse(
          await fetchJSON(baseUrl, `${communityPath(ref)}/rooms`)
        ),
        ref
      );
    },
    async getRemoteCommunityRoom(ref, roomId) {
      return qualified(
        RemoteCommunityRoomResponseSchema.parse(await fetchJSON(baseUrl, roomPath(ref, roomId)))
          .room,
        ref,
        roomId
      );
    },
    async listRemoteCommunityEntries(ref, roomId, query = {}) {
      const parsed = RemoteCommunityHistoryQuerySchema.parse(query);
      return qualified(
        RemoteCommunityHistoryResponseSchema.parse(
          await fetchJSON(baseUrl, `${roomPath(ref, roomId)}/entries${buildQueryString(parsed)}`)
        ),
        ref,
        roomId
      );
    },
    async postRemoteCommunityEntry(ref, roomId, input) {
      const request = RemoteCommunityPostRequestSchema.parse(input);
      return qualified(
        RemoteCommunityPostResponseSchema.parse(
          await fetchJSON(baseUrl, `${roomPath(ref, roomId)}/entries`, {
            method: 'POST',
            body: JSON.stringify(request),
          })
        ).entry,
        ref,
        roomId
      );
    },
    subscribeRemoteCommunityRoom: createRemoteCommunityStream(baseUrl),
    async listRemoteCommunityMembers(ref, roomId) {
      return qualified(
        RemoteCommunityMembersResponseSchema.parse(
          await fetchJSON(baseUrl, `${roomPath(ref, roomId)}/members`)
        ),
        ref,
        roomId
      );
    },
    async joinRemoteCommunityRoom(ref, roomId) {
      return qualified(
        RemoteCommunityRoomResponseSchema.parse(
          await fetchJSON(baseUrl, `${roomPath(ref, roomId)}/membership`, { method: 'POST' })
        ).room,
        ref,
        roomId
      );
    },
    leaveRemoteCommunityRoom(ref, roomId) {
      return fetchNoContent(baseUrl, `${roomPath(ref, roomId)}/membership`, { method: 'DELETE' });
    },
    async getRemoteCommunityReadCursor(ref, roomId) {
      return RemoteCommunityReadCursorSchema.parse(
        await fetchJSON(baseUrl, `${roomPath(ref, roomId)}/read-cursor`)
      );
    },
    async setRemoteCommunityReadCursor(ref, roomId, cursor) {
      return RemoteCommunityReadCursorSchema.parse(
        await fetchJSON(baseUrl, `${roomPath(ref, roomId)}/read-cursor`, {
          method: 'PUT',
          body: JSON.stringify({ cursor }),
        })
      );
    },
    async listRemoteCommunityAgents(ref) {
      return qualified(
        RemoteCommunityEnrollmentsResponseSchema.parse(
          await fetchJSON(baseUrl, `${communityPath(ref)}/agents`)
        ),
        ref
      ).agents;
    },
    async enrollRemoteCommunityAgent(ref, localAgentId, input = {}) {
      const request = RemoteCommunityEnrollRequestSchema.parse(input);
      const agent = qualified(
        RemoteCommunityEnrollmentResponseSchema.parse(
          await fetchJSON(baseUrl, `${agentPath(ref, localAgentId)}/enroll`, {
            method: 'POST',
            body: JSON.stringify(request),
          })
        ).agent,
        ref
      );
      if (agent.localAgentId !== localAgentId)
        throw new Error('The community returned a different agent.');
      return agent;
    },
    async ejectRemoteCommunityAgent(ref, localAgentId) {
      return RemoteCommunityEjectionResponseSchema.parse(
        await fetchJSON(baseUrl, agentPath(ref, localAgentId), { method: 'DELETE' })
      );
    },
    joinRemoteCommunityAgentRoom(ref, roomId, localAgentId) {
      return fetchNoContent(
        baseUrl,
        `${roomPath(ref, roomId)}/agents/${encodeURIComponent(localAgentId)}/membership`,
        { method: 'POST' }
      );
    },
    async leaveRemoteCommunityAgentRoom(ref, roomId, localAgentId) {
      return RemoteCommunityEjectionResponseSchema.parse(
        await fetchJSON(
          baseUrl,
          `${roomPath(ref, roomId)}/agents/${encodeURIComponent(localAgentId)}/membership`,
          { method: 'DELETE' }
        )
      );
    },
    async haltRemoteCommunityRoom(ref, roomId) {
      return HaltRoomResponseSchema.strict().parse(
        await fetchJSON(baseUrl, `${roomPath(ref, roomId)}/halt`, { method: 'POST' })
      );
    },
    async haltRemoteCommunityAgent(ref, roomId, localAgentId) {
      return HaltRoomResponseSchema.strict().parse(
        await fetchJSON(
          baseUrl,
          `${roomPath(ref, roomId)}/agents/${encodeURIComponent(localAgentId)}/halt`,
          { method: 'POST' }
        )
      );
    },
    async retryRemoteCommunityDelivery(ref, roomId, idempotencyKey) {
      if (!idempotencyKey || idempotencyKey.length > 128)
        throw new Error('The message retry key is invalid.');
      return qualified(
        CommunityDeliverySnapshotSchema.parse(
          await fetchJSON(
            baseUrl,
            `${roomPath(ref, roomId)}/deliveries/${encodeURIComponent(idempotencyKey)}/retry`,
            { method: 'POST' }
          )
        ),
        ref,
        roomId
      );
    },
    async uploadRemoteCommunityAttachment(ref, roomId, file, idempotencyKey) {
      if (file.size > MAX_FILE_BYTES) throw new Error('Files must be 25 MB or smaller.');
      if (!idempotencyKey || idempotencyKey.length > 128)
        throw new Error('The file retry key is invalid.');
      return RemoteCommunityAttachmentResponseSchema.parse(
        await fetchJSON(baseUrl, `${roomPath(ref, roomId)}/attachments`, {
          method: 'POST',
          // The route reads raw bytes. Setting this explicitly prevents the
          // HTTP helper's JSON default from sending the file through a parser.
          headers: {
            'Content-Type': 'application/octet-stream',
            'x-file-name': encodeURIComponent(file.name),
            'x-file-content-type': file.type || 'application/octet-stream',
            'x-file-size': String(file.size),
            'idempotency-key': idempotencyKey,
          },
          body: file,
        })
      ).attachment;
    },
    async downloadRemoteCommunityAttachment(ref, roomId, attachmentId) {
      const response = await fetchResponse(
        baseUrl,
        `${roomPath(ref, roomId)}/attachments/${encodeURIComponent(attachmentId)}`,
        { headers: {} }
      );
      return boundedBlob(response);
    },
  };
}

/** Enforce the hard ceiling on actual bytes, even when Content-Length is absent or false. */
async function boundedBlob(response: Response): Promise<Blob> {
  if (!response.body) throw new Error('The community returned an empty file response.');
  const reader = response.body.getReader();
  const chunks: ArrayBuffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_FILE_BYTES) throw new Error('The community file exceeds the 25 MB limit.');
      chunks.push(Uint8Array.from(value).buffer);
    }
    return new Blob(chunks, {
      type: response.headers.get('content-type') ?? 'application/octet-stream',
    });
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
