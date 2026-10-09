import type { z } from 'zod';
import {
  BrowserHumanGrantRequestSchema,
  BrowserHumanGrantRevokeSchema,
  BrowserGrantSchema,
  BrowserHumanStageRequestSchema,
  BrowserHumanStageReceiptSchema,
  BrowserHumanUploadRequestSchema,
  BrowserActionReceiptSchema,
  BrowserHumanDownloadRequestSchema,
  BrowserHumanDownloadReceiptSchema,
  BrowserHumanArtifactReadRequestSchema,
  BrowserHumanArtifactReceiptSchema,
  BrowserDiagnosticsRequestSchema,
  BrowserDiagnosticSummarySchema,
} from '@dorkos/shared/browser-schemas';
import type { BrowserFilesTransport, BrowserDiagnosticsTransport } from '@dorkos/shared/transport';
/** Uniform safe HTTP refusal; an unsuccessful request carries no admitted action receipt. */
export class BrowserHumanHttpRefusal extends Error {
  constructor(readonly status: number) {
    super(
      status === 400
        ? 'The browser request could not be read.'
        : status === 404
          ? 'Shared browser is unavailable.'
          : 'The browser operation could not be confirmed.'
    );
  }
}
/** Bounded original same-origin cookie wire. HTTP admission errors never masquerade as action receipts. */
export function createBrowserHumanHttp(baseUrl: string): {
  files: BrowserFilesTransport;
  diagnostics: BrowserDiagnosticsTransport;
} {
  const originalFetch = globalThis.fetch.bind(globalThis);
  async function post<S extends z.ZodType, O extends z.ZodType>(
    path: string,
    input: z.input<S>,
    schema: S,
    output: O,
    signal: AbortSignal,
    bound = 2820000
  ): Promise<z.output<O>> {
    const request = schema.parse(input);
    signal.throwIfAborted();
    const response = await originalFetch(`${baseUrl}/browser/${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal,
    });
    signal.throwIfAborted();
    if (!response.body) throw new Error('BROWSER_RESPONSE_MISSING');
    const reader = response.body.getReader();
    let first: Readonly<{ value: unknown }> | undefined;
    let result: z.output<O> | undefined;
    const chunks: Uint8Array[] = [];
    try {
      if (!response.ok) throw new BrowserHumanHttpRefusal(response.status);
      let length = 0;
      while (true) {
        const next = await reader.read();
        if (!next.done) chunks.push(next.value); // Retain even the chunk that exceeds the bound or races abort.
        signal.throwIfAborted();
        if (next.done) break;
        length += next.value.byteLength;
        if (length > bound) throw new Error('BROWSER_RESPONSE_BOUND');
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      try {
        result = output.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
      } finally {
        bytes.fill(0);
      }
    } catch (value) {
      first = { value };
    } finally {
      for (const chunk of chunks) {
        try {
          chunk.fill(0);
        } catch (value) {
          first ??= { value };
        }
      }
    }
    for (const cleanup of [() => reader.cancel(), () => reader.releaseLock()]) {
      try {
        await cleanup();
      } catch (value) {
        first ??= { value };
      }
    }
    if (first) throw first.value;
    signal.throwIfAborted();
    return result!;
  }
  const bindingMatches = (request: { binding: object }, actual: { binding: object }) => {
    for (const key of Object.keys(request.binding))
      if (Reflect.get(request.binding, key) !== Reflect.get(actual.binding, key))
        throw new Error('BROWSER_BINDING_MISMATCH');
  };
  return Object.freeze({
    files: Object.freeze({
      async issueBrowserFileGrant(request, signal) {
        const result = await post(
          'files/grant',
          request,
          BrowserHumanGrantRequestSchema,
          BrowserGrantSchema,
          signal,
          16384
        );
        if (
          result.tabId !== request.binding.tabId ||
          result.revokedAt !== null ||
          JSON.stringify(result.attachment) !== JSON.stringify(request.attachment) ||
          result.permissions.length !== request.permissions.length ||
          request.permissions.some((permission) => !result.permissions.includes(permission))
        )
          throw new Error('BROWSER_GRANT_MISMATCH');
        return result;
      },
      async revokeBrowserFileGrant(request, signal) {
        const result = await post(
          'files/revoke',
          request,
          BrowserHumanGrantRevokeSchema,
          BrowserGrantSchema,
          signal,
          16384
        );
        if (
          result.tabId !== request.binding.tabId ||
          result.grantId !== request.grant.grantId ||
          result.grantRevision !== request.grant.revision + 1 ||
          result.revokedAt === null
        )
          throw new Error('BROWSER_GRANT_MISMATCH');
        return result;
      },
      stageBrowserFile: (request, signal) =>
        post(
          'files/stage',
          request,
          BrowserHumanStageRequestSchema,
          BrowserHumanStageReceiptSchema,
          signal,
          16384
        ),
      async uploadBrowserFile(request, signal) {
        const result = await post(
          'files/upload',
          request,
          BrowserHumanUploadRequestSchema,
          BrowserActionReceiptSchema,
          signal,
          16384
        );
        bindingMatches(request, result);
        if (result.requestId !== request.command.requestId)
          throw new Error('BROWSER_REQUEST_MISMATCH');
        return result;
      },
      async downloadBrowserFile(request, signal) {
        const result = await post(
          'files/download',
          request,
          BrowserHumanDownloadRequestSchema,
          BrowserHumanDownloadReceiptSchema,
          signal,
          16384
        );
        bindingMatches(request, result.input);
        if (result.input.requestId !== request.command.requestId)
          throw new Error('BROWSER_REQUEST_MISMATCH');
        return result;
      },
      async readBrowserArtifact(request, signal) {
        const result = await post(
          'files/read',
          request,
          BrowserHumanArtifactReadRequestSchema,
          BrowserHumanArtifactReceiptSchema,
          signal
        );
        if (request.artifactId !== result.artifactId) throw new Error('BROWSER_ARTIFACT_MISMATCH');
        const decoded = atob(result.base64);
        if (decoded.length !== result.byteLength || btoa(decoded) !== result.base64)
          throw new Error('BROWSER_ARTIFACT_LENGTH');
        return result;
      },
    } satisfies BrowserFilesTransport),
    diagnostics: Object.freeze({
      async readBrowserDiagnostics(request, signal) {
        const result = await post(
          'diagnostics',
          request,
          BrowserDiagnosticsRequestSchema,
          BrowserDiagnosticSummarySchema,
          signal,
          266240
        );
        bindingMatches(request, result);
        return result;
      },
    } satisfies BrowserDiagnosticsTransport),
  });
}
