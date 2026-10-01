/** Authorized document channel reads; transport and event admission arrive later. */
import type { CanvasDocumentStore } from '../canvas-document-store.js';
import {
  DocChannelAuthorization,
  DocChannelNotFoundError,
  type DocChannelActor,
} from './authorization.js';
import { DocChannelStore, type DocChannelRow } from './store.js';

/** A current document's private channel data, returned only after scope authorization. */
export class DocChannelService {
  /** Compose existing authorization and persistence without activating a transport. */
  constructor(
    private readonly documents: CanvasDocumentStore,
    private readonly channels: DocChannelStore,
    private readonly authorization: DocChannelAuthorization
  ) {}
  /** Read live channel state after authorizing the current physical document. */
  async readChannel(documentId: string, actor: DocChannelActor): Promise<DocChannelRow> {
    const identity = await this.authorization.require(documentId, actor);
    this.authorization.requireCurrent(documentId, actor);
    const channel = this.channels.getChannel(identity.id);
    if (!channel || channel.closedAt !== null || channel.scope !== identity.scope)
      throw new DocChannelNotFoundError();
    return channel;
  }
  /** Read only recovery health for an authorized operator while admission is blocked. */
  readHealth(
    documentId: string,
    actor: DocChannelActor
  ): { status: 'ready' | 'in_doubt'; reasons: string[] } {
    this.authorization.requireHealth(documentId, actor);
    return this.documents.lifecycle.health(documentId);
  }
  /** Recheck lifecycle and scope before any later mutating operation. */
  async requireWrite(
    documentId: string,
    actor: DocChannelActor
  ): Promise<{ id: string; scope: string }> {
    const identity = await this.authorization.require(documentId, actor, true);
    this.authorization.requireCurrent(documentId, actor, true);
    const channel = this.channels.getChannel(identity.id);
    if (!channel || channel.closedAt !== null || !this.documents.lookupIdentity(identity.id))
      throw new DocChannelNotFoundError();
    return identity;
  }
}
