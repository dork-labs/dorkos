import {
  AmbiguousSessionError,
  SessionDiscoveryUnavailableError,
} from '../../session/resolution/session-lookup-error.js';
/** Native local Codex history, shared by exec and app-server without starting a model turn. */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { describeRuntimeError } from '@dorkos/shared/runtime-error-classification';
import type { Session, HistoryMessage, HistoryToolCall, MessagePart } from '@dorkos/shared/types';
import { isWithinDirectory } from '@dorkos/shared/paths';
import { resolveCodexHome, codexRolloutRootsIn } from './codex-home.js';
import { discoverCodexRollouts } from '../../search/codex-discovery.js';
import { projectCodexLines } from '../../search/projections/codex.js';
import type { FileContainer, KnownContainer } from '../../search/types.js';
import {
  MAX_SESSION_ATTACHMENT_BYTES,
  deriveSessionAttachmentId,
  type SessionAttachmentStore,
} from '../../session/attachments/index.js';
import { validateBoundaryOrDorkHome } from '../../../lib/boundary.js';

/**
 * How long one inventory of the Codex home is reused before the rollout roots
 * are walked again. Every caller inside the window shares one walk.
 */
const INVENTORY_TTL_MS = 1_000;

/** What a rollout's head says. A rollout is append-only, so this never changes for a file. */
interface RolloutHead {
  metadata: { timestamp?: unknown; payload: { id: string; cwd: string } } | undefined;
  firstMessage:
    { role: 'user' | 'assistant'; content: string; timestamp: string | null } | undefined;
}

/**
 * Read-only native store lookup. Only this machine's selected Codex home is inspected.
 *
 * **Every read is remembered, because the store is large and listed often.** A
 * session list fans out across every agent's folder, so one sidebar refresh asks
 * this reader for many directories at once, and a real Codex home holds hundreds
 * of rollouts and many gigabytes (13 GB, 367 files measured on 2026-10-13). Before
 * these caches, every inventory older than a second re-read the head of every
 * rollout, and every listing re-read the head of every matching one, which kept
 * the server so busy that each request took seconds. A rollout is append-only and
 * its head never changes, so its working directory and opening lines are read
 * once; after that an unchanged file costs one `stat`.
 */
export class CodexNativeSessionReader {
  private inventory: { at: number; files: Promise<FileContainer[]> } | undefined;
  private readonly knownNativeSessions = new Set<string>();
  /** The last inventory's files by container id, so unchanged files skip the head read. */
  private known = new Map<string, KnownContainer>();
  /**
   * Each rollout's head, by file path, with the file size it was read at.
   * Pruned to the files the last inventory found.
   */
  private readonly heads = new Map<
    string,
    { sizeBytes: number; mtimeMs: number; complete: boolean; read: Promise<RolloutHead> }
  >();
  /** Each rollout's working directory, by file path, once its metadata is written. */
  private readonly cwds = new Map<string, string>();
  constructor(
    private readonly home: () => string = resolveCodexHome,
    private readonly attachments: SessionAttachmentStore | null = null
  ) {}

  private async containers(): Promise<FileContainer[]> {
    if (this.inventory && Date.now() - this.inventory.at < INVENTORY_TTL_MS)
      return this.inventory.files;
    const files = discoverCodexRollouts(codexRolloutRootsIn(this.home()), this.known, (filePath) =>
      this.cachedCwd(filePath)
    ).then((discovered) => {
      if (discovered.failures.length) throw new Error('Codex native history could not be read');
      this.remember(discovered.files);
      return discovered.files;
    });
    this.inventory = { at: Date.now(), files };
    try {
      return await files;
    } catch (error) {
      this.inventory = undefined;
      throw error;
    }
  }

  /**
   * Keep what this inventory found for the next one, and forget the heads of
   * files that are gone, so neither cache grows past the store it describes.
   *
   * @param files - The containers the inventory just discovered.
   */
  private remember(files: FileContainer[]): void {
    const known = new Map<string, KnownContainer>();
    const present = new Set<string>();
    for (const file of files) {
      known.set(file.originKey, {
        sizeBytes: file.sizeBytes,
        mtimeMs: file.mtimeMs,
        containerPath: file.containerPath,
      });
      present.add(file.filePath);
    }
    this.known = known;
    for (const filePath of this.heads.keys())
      if (!present.has(filePath)) this.heads.delete(filePath);
    for (const filePath of this.cwds.keys()) if (!present.has(filePath)) this.cwds.delete(filePath);
  }

  /**
   * A rollout's working directory, read from its metadata line once per file.
   *
   * Reads only up to the metadata record, as discovery always has. A rollout
   * whose metadata is not written yet answers `null` and is asked again later.
   *
   * @param filePath - The rollout to read.
   */
  private async cachedCwd(filePath: string): Promise<string | null> {
    const known = this.cwds.get(filePath);
    if (known !== undefined) return known;
    const cwd = (await this.head(filePath, false)).metadata?.payload.cwd ?? null;
    if (cwd !== null) this.cwds.set(filePath, cwd);
    return cwd;
  }

  /**
   * A rollout's head (its metadata and first user message), read once per file.
   *
   * Concurrent callers share one read. A COMPLETE head (metadata and a first
   * user message both found) is kept while the file only grows, because a
   * rollout is append-only. A head missing either is kept only while the file
   * is unchanged (same size and mtime): a
   * rollout that is still being written may not hold them yet, and remembering
   * that half-read answer past the next write would hide the session or its
   * title for good. A failed read is not kept.
   *
   * @param file - The rollout, with its current size.
   */
  private cachedHead(file: FileContainer): Promise<RolloutHead> {
    const cached = this.heads.get(file.filePath);
    if (cached) {
      // A complete head holds while the file only grows; a shrink means it was
      // rewritten, not appended. An incomplete head holds only while the file is
      // exactly as it was, by the same (size, mtime) test discovery uses.
      const fresh = cached.complete
        ? file.sizeBytes >= cached.sizeBytes
        : cached.sizeBytes === file.sizeBytes && cached.mtimeMs === file.mtimeMs;
      if (fresh) return cached.read;
    }
    const read = this.head(file.filePath, true);
    const entry = { sizeBytes: file.sizeBytes, mtimeMs: file.mtimeMs, complete: false, read };
    this.heads.set(file.filePath, entry);
    read.then(
      (head) => {
        if (head.metadata && head.firstMessage) entry.complete = true;
      },
      () => {
        if (this.heads.get(file.filePath) === entry) this.heads.delete(file.filePath);
      }
    );
    return read;
  }

  private async head(filePath: string, includeFirstMessage: boolean): Promise<RolloutHead> {
    const input = createReadStream(filePath);
    const lines = createInterface({ input, crlfDelay: Infinity });
    let metadata;
    let firstMessage;
    let count = 0;
    try {
      for await (const line of lines) {
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        if (
          record?.type === 'session_meta' &&
          typeof record.payload?.id === 'string' &&
          typeof record.payload?.cwd === 'string'
        )
          metadata = record;
        if (metadata && !includeFirstMessage) break;
        const projected = projectCodexLines([line], { originKey: '', firstOrdinal: 0 }).messages;
        firstMessage = projected.find((message) => message.role === 'user');
        if (firstMessage || ++count >= 500) break;
      }
    } finally {
      lines.close();
      input.destroy();
    }
    return {
      metadata,
      firstMessage: firstMessage
        ? { role: firstMessage.role, content: firstMessage.body, timestamp: firstMessage.createdAt }
        : undefined,
    };
  }

  private async session(file: FileContainer): Promise<Session | null> {
    if (!file.containerPath) return null;
    await validateBoundaryOrDorkHome(file.containerPath);
    const { metadata, firstMessage } = await this.cachedHead(file);
    if (metadata?.payload.id !== file.originKey) return null;
    const history = firstMessage ? [firstMessage] : [];
    const first = history.find((m) => m.role === 'user');
    return {
      id: file.originKey,
      runtime: 'codex',
      account: this.home(),
      cwd: file.containerPath,
      title: first?.content.split('\n')[0]?.slice(0, 80) ?? '',
      createdAt:
        typeof metadata.timestamp === 'string'
          ? metadata.timestamp
          : (history[0]?.timestamp ?? new Date(file.mtimeMs).toISOString()),
      updatedAt: new Date(file.mtimeMs).toISOString(),
      permissionMode: 'default',
    };
  }

  async findSession(id: string): Promise<Session | null> {
    if (!/^[a-f0-9-]{36}$/i.test(id)) return null;
    const matching = (await this.containers()).filter((file) => file.originKey === id);
    if (matching.length > 1) throw new AmbiguousSessionError();
    const session = matching[0] ? await this.session(matching[0]) : null;
    if (session) this.knownNativeSessions.add(id);
    return session;
  }

  async listSessions(directory: string): Promise<Session[]> {
    const files = (await this.containers()).filter((file) =>
      isWithinDirectory(file.containerPath ?? undefined, directory)
    );
    const sessions = await Promise.all(files.map((file) => this.session(file)));
    const found = sessions.filter((session): session is Session => session !== null);
    for (const session of found) this.knownNativeSessions.add(session.id);
    return found;
  }

  async readHistory(id: string, options: { required?: boolean } = {}): Promise<HistoryMessage[]> {
    const required = options.required || this.knownNativeSessions.has(id);
    try {
      const matching = (await this.containers()).filter((file) => file.originKey === id);
      if (matching.length > 1) throw new AmbiguousSessionError();
      const file = matching[0];
      if (!file?.containerPath || !(await this.session(file))) {
        if (required) throw new SessionDiscoveryUnavailableError('codex');
        return [];
      }
      // One inventory lookup for identity and history: an empty transcript is
      // valid, but a known imported thread must never become a partial log.
      return await this.history(file);
    } catch (error) {
      if (
        required &&
        !(error instanceof AmbiguousSessionError) &&
        !(error instanceof Error && error.name === 'BoundaryError')
      )
        throw new SessionDiscoveryUnavailableError('codex');
      throw error;
    }
  }

  private async image(
    sessionId: string,
    identity: string,
    block: Record<string, unknown>
  ): Promise<MessagePart> {
    try {
      if (!this.attachments) throw new Error('Images cannot be loaded here.');
      const raw = typeof block.image_url === 'string' ? block.image_url : null;
      const match = raw?.match(
        /^data:(image\/(?:png|jpeg|gif|webp));base64,([a-zA-Z0-9+/=\r\n]+)$/
      );
      const mediaType =
        match?.[1] ?? (typeof block.mimeType === 'string' ? block.mimeType : undefined);
      const base64 = match?.[2] ?? (typeof block.data === 'string' ? block.data : undefined);
      if (!mediaType || !base64) throw new Error('This image format cannot be loaded.');
      if (base64.length > Math.ceil(MAX_SESSION_ATTACHMENT_BYTES / 3) * 4)
        throw new Error('This image is too large to load.');
      const attachmentId = deriveSessionAttachmentId(['codex-native', sessionId, identity]);
      const stored =
        (await this.attachments.peek(sessionId, attachmentId, mediaType)) ??
        (await this.attachments.put(
          sessionId,
          attachmentId,
          mediaType,
          Buffer.from(base64, 'base64')
        ));
      return { type: 'image', attachmentId, ...stored };
    } catch {
      return { type: 'error', message: 'An image in this chat could not be loaded.' };
    }
  }

  private async history(file: FileContainer): Promise<HistoryMessage[]> {
    const lines = createInterface({ input: createReadStream(file.filePath), crlfDelay: Infinity });
    const messages: HistoryMessage[] = [];
    const tools = new Map<string, HistoryToolCall>();
    let ordinal = 0;
    let recordOrdinal = 0;
    for await (const line of lines) {
      const recordIndex = recordOrdinal++;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record?.type === 'event_msg' && record.payload?.type === 'error') {
        const raw =
          typeof record.payload.message === 'string'
            ? record.payload.message
            : typeof record.payload.error === 'string'
              ? record.payload.error
              : 'A recorded turn failed.';
        const copy = describeRuntimeError({ runtimeType: 'codex', message: raw });
        messages.push({
          id: `native-error-${recordIndex}`,
          role: 'assistant',
          content: '',
          parts: [{ type: 'error', ...copy }],
          ...(record.timestamp ? { timestamp: record.timestamp } : {}),
        });
        continue;
      }
      if (record?.type === 'compacted') {
        messages.push({
          id: `native-compaction-${recordIndex}`,
          role: 'assistant',
          content: typeof record.payload?.message === 'string' ? record.payload.message : '',
          messageType: 'compaction',
        });
        continue;
      }
      if (record?.type !== 'response_item') continue;
      const payload = record.payload;
      if (
        (payload?.type === 'function_call' || payload?.type === 'custom_tool_call') &&
        typeof payload.call_id === 'string' &&
        typeof payload.name === 'string'
      ) {
        const tool: HistoryToolCall = {
          toolCallId: payload.call_id,
          toolName: payload.name,
          input:
            typeof payload.arguments === 'string'
              ? payload.arguments
              : typeof payload.input === 'string'
                ? payload.input
                : undefined,
          status: 'running',
        };
        tools.set(payload.call_id, tool);
        messages.push({
          id: `native-tool-${payload.call_id}`,
          role: 'assistant',
          content: '',
          toolCalls: [tool],
          ...(record.timestamp ? { timestamp: record.timestamp } : {}),
        });
      } else if (
        payload?.type === 'function_call_output' ||
        payload?.type === 'custom_tool_call_output'
      ) {
        const tool = tools.get(payload.call_id);
        if (tool) {
          let output = payload.output;
          if (typeof output === 'string') {
            try {
              output = JSON.parse(output);
            } catch {
              /* Plain tool text stays text. */
            }
          }
          const blocks: Record<string, unknown>[] | null = Array.isArray(output)
            ? output
            : Array.isArray(output?.content)
              ? output.content
              : null;
          const images =
            blocks?.filter((block) => block?.type === 'image' || block?.type === 'input_image') ??
            [];
          tool.result = images.length
            ? (blocks ?? [])
                .filter((block) => block?.type !== 'image' && block?.type !== 'input_image')
                .map((block) =>
                  typeof block?.text === 'string' ? block.text : JSON.stringify(block)
                )
                .join('\n')
            : typeof payload.output === 'string'
              ? payload.output
              : JSON.stringify(payload.output);
          tool.status =
            payload.is_error === true || output?.isError === true ? 'error' : 'complete';
          if (images.length) {
            const message = messages.find((message) => message.toolCalls?.includes(tool));
            if (message) {
              const media = await Promise.all(
                images.map((block: Record<string, unknown>, index: number) =>
                  this.image(file.originKey, `${payload.call_id}-${index}`, block)
                )
              );
              message.parts = [{ type: 'tool_call', ...tool }, ...media];
            }
          }
        }
      } else if (payload?.type === 'reasoning') {
        const text = [
          ...(Array.isArray(payload.summary) ? payload.summary : []),
          ...(Array.isArray(payload.content) ? payload.content : []),
        ]
          .filter((part) => typeof part?.text === 'string')
          .map((part) => part.text)
          .join('\n');
        if (text)
          messages.push({
            id: payload.id ?? `native-thinking-${recordIndex}`,
            role: 'assistant',
            content: '',
            parts: [{ type: 'thinking', text, isStreaming: false }],
          });
      } else if (payload?.type !== 'message') {
        // Preserve unsupported native records as a visible diagnostic rather than losing them.
        messages.push({
          id: payload?.id ?? `native-unsupported-${recordIndex}`,
          role: 'assistant',
          content: '',
          parts: [
            {
              type: 'error',
              message: 'A recorded item could not be displayed.',
              category: 'output_format_error',
              details: JSON.stringify(payload),
            },
          ],
        });
      } else {
        const media: MessagePart[] = [];
        for (const [index, block] of (Array.isArray(payload?.content)
          ? payload.content
          : []
        ).entries()) {
          if (
            block?.type === 'input_image' ||
            block?.type === 'image' ||
            block?.type === 'local_image'
          )
            media.push(await this.image(file.originKey, `${recordIndex}-${index}`, block));
        }
        const projected = projectCodexLines([line], {
          originKey: file.originKey,
          firstOrdinal: ordinal,
        });
        for (const message of projected.messages) {
          messages.push({
            id: message.messageId ?? `native-${message.ordinal}`,
            role: message.role,
            content: message.body,
            ...(message.createdAt ? { timestamp: message.createdAt } : {}),
          });
          if (media.length)
            messages.at(-1)!.parts = [{ type: 'text', text: message.body }, ...media];
          ordinal += 1;
        }
        if (
          media.length &&
          !projected.messages.length &&
          (payload.role === 'user' || payload.role === 'assistant')
        ) {
          messages.push({
            id: payload.id ?? `native-media-${recordIndex}`,
            role: payload.role,
            content: '',
            parts: media,
          });
        }
      }
    }
    return messages;
  }
}
