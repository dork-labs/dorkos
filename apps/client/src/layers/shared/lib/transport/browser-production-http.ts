import {
  BrowserLocalDestinationRequestSchema,
  BrowserLocalDestinationReceiptSchema,
  BrowserProductionOpenRequestSchema,
  BrowserProductionNavigateRequestSchema,
  BrowserProductionNavigateReceiptSchema,
  BrowserProductionOpenReceiptSchema,
  BrowserProductionStatusSchema,
  BrowserProductionEnableRequestSchema,
  BrowserProductionProfileImportRequestSchema,
  BrowserProductionProfileImportReceiptSchema,
  type BrowserProductionProfileImportRequest,
  BrowserProductionProfileCreateRequestSchema,
  BrowserProductionProfileCreateReceiptSchema,
  BrowserBindingSchema,
  BrowserProductionControlRequestSchema,
  BrowserControlSchema,
  BrowserReferenceSchema,
  BrowserCounterSchema,
  type BrowserLocalDestinationRequest,
  type BrowserBinding,
  type BrowserOpenRequest,
  type BrowserProductionProfileCreateRequest,
  type BrowserNavigateRequest,
} from '@dorkos/shared/browser-schemas';
import type { BrowserProductionTransport } from '@dorkos/shared/transport';
import { z } from 'zod';
import { fetchJSON } from './http-client';

const sameLifetime = (binding: BrowserBinding, browserId: string, generation: number) =>
  binding.browserId === browserId && binding.browserGeneration === generation;

/** Session-cookie wire only. Its existence never enables the experiment or proves native readiness. */
export function createBrowserProductionHttp(baseUrl: string): BrowserProductionTransport {
  return Object.freeze({
    async allowBrowserLocalDestination(
      request: BrowserLocalDestinationRequest,
      signal: AbortSignal
    ) {
      const original = BrowserLocalDestinationRequestSchema.parse(request);
      signal.throwIfAborted();
      const response = await fetchJSON<unknown>(baseUrl, '/browser/runtime/local-destination', {
        method: 'POST',
        body: JSON.stringify(original),
        signal,
      });
      signal.throwIfAborted();
      const receipt = BrowserLocalDestinationReceiptSchema.parse(response);
      if (
        receipt.requestId !== original.requestId ||
        receipt.endpoint !== new URL(original.endpoint).origin ||
        ![
          'browserId',
          'browserGeneration',
          'tabId',
          'epoch',
          'inputGeneration',
          'navigationGeneration',
          'viewportVersion',
        ].every(
          (key) => Reflect.get(receipt.binding, key) === Reflect.get(original.binding, key)
        ) ||
        Date.parse(receipt.expiresAt) <= Date.now()
      )
        throw new Error('Local website permission could not be confirmed.');
      return Object.freeze({
        ...receipt,
        binding: Object.freeze({ ...receipt.binding }),
      });
    },
    async importBrowserProfile(
      request: BrowserProductionProfileImportRequest,
      signal: AbortSignal
    ) {
      const original = BrowserProductionProfileImportRequestSchema.parse(request);
      signal.throwIfAborted();
      const response = await fetchJSON<unknown>(baseUrl, '/browser/runtime/profiles/import', {
        method: 'POST',
        body: JSON.stringify(original),
        signal,
      });
      signal.throwIfAborted();
      const receipt = BrowserProductionProfileImportReceiptSchema.parse(response);
      if (
        receipt.requestId !== original.requestId ||
        receipt.profile.label !== original.label ||
        receipt.profile.status !== 'available'
      )
        throw new Error('The imported browser profile could not be confirmed.');
      return Object.freeze({ ...receipt, profile: Object.freeze({ ...receipt.profile }) });
    },
    async createBrowserProfile(
      request: BrowserProductionProfileCreateRequest,
      signal: AbortSignal
    ) {
      const original = BrowserProductionProfileCreateRequestSchema.parse(request);
      signal.throwIfAborted();
      const response = await fetchJSON<unknown>(baseUrl, '/browser/runtime/profiles', {
        method: 'POST',
        body: JSON.stringify(original),
        signal,
      });
      signal.throwIfAborted();
      const receipt = BrowserProductionProfileCreateReceiptSchema.parse(response);
      if (
        receipt.requestId !== original.requestId ||
        receipt.profile.label !== original.label ||
        receipt.profile.status !== 'available'
      )
        throw new Error('Browser profile creation could not be confirmed.');
      return Object.freeze({
        ...receipt,
        profile: Object.freeze({ ...receipt.profile }),
      });
    },
    async setBrowserRuntimeEnabled(
      enabled: boolean,
      signal: AbortSignal,
      choice?: Readonly<{ chromeUserAgent: boolean }>
    ) {
      const original = BrowserProductionEnableRequestSchema.parse({ enabled, ...choice });
      const result = BrowserProductionStatusSchema.parse(
        await fetchJSON<unknown>(baseUrl, '/browser/runtime/enable', {
          method: 'POST',
          body: JSON.stringify(original),
          signal,
        })
      );
      if (result.enabled !== original.enabled || (!original.enabled && result.state !== 'disabled'))
        throw new Error('Browser setting could not be confirmed.');
      return result;
    },
    async readBrowserRuntimeStatus(signal: AbortSignal) {
      return BrowserProductionStatusSchema.parse(
        await fetchJSON<unknown>(baseUrl, '/browser/runtime/status', {
          signal,
        })
      );
    },
    async openBrowserRuntime(
      workspaceId: string,
      request: BrowserOpenRequest,
      signal: AbortSignal,
      initialUrl?: string
    ) {
      const original = BrowserProductionOpenRequestSchema.parse({
        workspaceId,
        request,
        ...(initialUrl === undefined ? {} : { initialUrl }),
      });
      const result = BrowserProductionOpenReceiptSchema.parse(
        await fetchJSON<unknown>(baseUrl, '/browser/runtime/open', {
          method: 'POST',
          body: JSON.stringify(original),
          signal,
        })
      );
      if (
        result.requestId !== original.request.requestId ||
        result.instance.mode !== original.request.mode ||
        (original.request.mode === 'persistent' &&
          (result.instance.mode !== 'persistent' ||
            result.instance.profileId !== original.request.profileId))
      )
        throw new Error('Browser response did not match the open request.');
      return Object.freeze({
        ...result,
        instance: Object.freeze({ ...result.instance }),
        binding: Object.freeze({ ...result.binding }),
      });
    },
    async navigateBrowser(
      command: BrowserNavigateRequest,
      controllerId: string,
      signal: AbortSignal
    ) {
      const original = BrowserProductionNavigateRequestSchema.parse({
        command,
        controllerId,
      });
      signal.throwIfAborted();
      const document = await fetchJSON<unknown>(baseUrl, '/browser/runtime/navigate', {
        method: 'POST',
        body: JSON.stringify(original),
        signal,
      });
      signal.throwIfAborted();
      const result = BrowserProductionNavigateReceiptSchema.parse(document);
      const before = original.command.binding,
        after = result.binding;
      if (
        result.requestId !== original.command.requestId ||
        !sameLifetime(after, before.browserId, before.browserGeneration) ||
        after.tabId !== before.tabId ||
        after.viewportVersion !== before.viewportVersion ||
        after.navigationGeneration !== before.navigationGeneration + 1 ||
        after.epoch !== before.epoch + 1 ||
        after.inputGeneration !== before.inputGeneration + 1
      )
        throw new Error('Browser navigation could not be confirmed.');
      return Object.freeze({ ...result, binding: Object.freeze({ ...after }) });
    },
    async getBrowserBindings(browserId: string, browserGeneration: number, signal: AbortSignal) {
      const id = BrowserReferenceSchema.parse(browserId);
      const generation = BrowserCounterSchema.parse(browserGeneration);
      const result = z
        .array(BrowserBindingSchema)
        .max(64)
        .parse(
          await fetchJSON<unknown>(
            baseUrl,
            `/browser/${encodeURIComponent(id)}/tabs?browserGeneration=${generation}`,
            { signal }
          )
        );
      if (result.some((binding) => !sameLifetime(binding, id, generation)))
        throw new Error('Browser response did not match the selected browser.');
      if (new Set(result.map((binding) => binding.tabId)).size !== result.length)
        throw new Error('Browser response repeated a tab.');
      return result.map((binding) => Object.freeze({ ...binding }));
    },
    async takeBrowserControl(binding: BrowserBinding, signal: AbortSignal) {
      const original = BrowserProductionControlRequestSchema.parse({ binding });
      const result = BrowserControlSchema.parse(
        await fetchJSON<unknown>(baseUrl, '/browser/control', {
          method: 'POST',
          body: JSON.stringify(original.binding),
          signal,
        })
      );
      // Takeover legitimately advances only the paired input protocol counters.
      const before = original.binding;
      const after = result.binding;
      if (
        !sameLifetime(after, before.browserId, before.browserGeneration) ||
        after.tabId !== before.tabId ||
        after.navigationGeneration !== before.navigationGeneration ||
        after.viewportVersion !== before.viewportVersion ||
        after.epoch !== before.epoch + 1 ||
        after.inputGeneration !== before.inputGeneration + 1 ||
        result.status !== 'ready' ||
        result.controllerId === null
      )
        throw new Error('Browser control could not be confirmed.');
      return Object.freeze({ ...result, binding: Object.freeze({ ...after }) });
    },
  });
}
