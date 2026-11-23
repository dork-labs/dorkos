import type { Hono, Context } from 'hono';
import { z } from 'zod';
import {
  browserViewerInputSchema,
  viewerControlRefSchema,
  viewerOperationSchema,
  viewerSecretSchema,
} from '@dorkos/shared/browser-viewer-control';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '@dorkos/http-kit';
import type { BrowserViewerRegistry } from '../services/session/browser-viewers/viewer-registry.js';
import type { ViewerPrincipal } from '../services/session/browser-viewers/viewer-contract.js';
import { BrowserViewerError } from '../services/session/browser-viewers/viewer-contract.js';
import { readViewerUpload } from '../services/session/browser-viewers/viewer-upload.js';

const inputSchema = viewerOperationSchema.extend({ input: browserViewerInputSchema }).strict();
const pasteSchema = viewerOperationSchema.extend({ text: z.string().max(2048) }).strict();
const endSchema = viewerControlRefSchema.extend({ action: z.enum(['resume', 'abandon']) }).strict();
const filesSchema = viewerOperationSchema.extend({ ticketId: viewerSecretSchema }).strict();
const cancelSchema = viewerControlRefSchema
  .extend({ action: z.literal('cancel'), ticketId: viewerSecretSchema })
  .strict();

/** Six finite person verbs; no agent capability, target, protocol or path enters here. */
export function mountViewerControls(
  router: Hono<ApiEnv>,
  registry: BrowserViewerRegistry,
  enabled: () => boolean,
  principal: (c: Context<ApiEnv>) => ViewerPrincipal,
  authorize: (c: Context<ApiEnv>) => Promise<void>
) {
  const allowed = (c: Context<ApiEnv>) => {
    if (!enabled()) {
      registry.disableInput();
      throw new BrowserViewerError('viewer_denied');
    }
    return principal(c);
  };
  const control = (c: Context<ApiEnv>, nonce: string) =>
    registry.control(allowed(c), c.req.param('viewerId')!, nonce);
  const metadata = (c: Context<ApiEnv>, nonce: string) =>
    registry.metadata(principal(c), c.req.param('viewerId')!, nonce);
  router.post('/:viewerId/take-over', async (c) => {
    const { nonce } = z.object({ nonce: viewerSecretSchema }).strict().parse(readJsonBody(c));
    await control(c, nonce).take(() => authorize(c));
    await authorize(c);
    return c.json({ metadata: metadata(c, nonce) });
  });
  router.post('/:viewerId/input', async (c) => {
    const envelope = inputSchema.parse(readJsonBody(c));
    const view = metadata(c, envelope.nonce),
      input = envelope.input;
    const points = input.kind === 'touch' ? input.points : 'x' in input ? [input] : [];
    if (
      !view.viewport ||
      points.some((p) => p.x >= view.viewport!.width || p.y >= view.viewport!.height)
    )
      throw new BrowserViewerError('viewer_stale');
    const result = await control(c, envelope.nonce).run(
      envelope,
      (lease, admit) => lease.runPerson(input, admit),
      () => authorize(c)
    );
    await authorize(c);
    return c.json({ ...result, metadata: metadata(c, envelope.nonce) });
  });
  router.post('/:viewerId/hand-back', async (c) => {
    const envelope = endSchema.parse(readJsonBody(c));
    await control(c, envelope.nonce).end(
      envelope.controllerId,
      envelope.controlEpoch,
      envelope.action === 'resume',
      () => authorize(c)
    );
    await authorize(c);
    return c.json({ metadata: metadata(c, envelope.nonce) });
  });
  router.post('/:viewerId/copy', async (c) => {
    const envelope = viewerOperationSchema.parse(readJsonBody(c));
    const result = await control(c, envelope.nonce).run(
      envelope,
      (lease, admit) => lease.readSelection(admit),
      () => authorize(c)
    );
    await authorize(c);
    return c.json({ ...result, metadata: metadata(c, envelope.nonce) });
  });
  router.post('/:viewerId/paste', async (c) => {
    const envelope = pasteSchema.parse(readJsonBody(c));
    const result = await control(c, envelope.nonce).run(
      envelope,
      (lease, admit) => lease.runPerson({ kind: 'text', text: envelope.text }, admit),
      () => authorize(c)
    );
    await authorize(c);
    return c.json({ ...result, metadata: metadata(c, envelope.nonce) });
  });
  router.post('/:viewerId/files', async (c) => {
    if (!c.req.header('content-type')?.startsWith('multipart/form-data')) {
      const envelope = cancelSchema.parse(readJsonBody(c));
      await authorize(c);
      await control(c, envelope.nonce).cancel(
        envelope.controllerId,
        envelope.controlEpoch,
        envelope.ticketId
      );
      await authorize(c);
      return c.json({ metadata: metadata(c, envelope.nonce) });
    }
    const raw = c.req.header('x-viewer-control');
    if (!raw || raw.length > 2048) throw new BrowserViewerError('viewer_denied');
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new BrowserViewerError('viewer_denied');
    }
    const envelope = filesSchema.parse(value);
    await authorize(c);
    const result = await control(c, envelope.nonce).files(
      envelope,
      envelope.ticketId,
      () => readViewerUpload(c.env.incoming, c.req.raw.signal),
      () => authorize(c)
    );
    await authorize(c);
    return c.json({ ...result, metadata: metadata(c, envelope.nonce) });
  });
}
