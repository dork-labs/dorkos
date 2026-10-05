import { it, expect } from 'vitest';
import {
  BrowserOpenRequestSchema,
  BrowserGrantSchema,
  BrowserGrantChangeRequestSchema,
  BrowserInputRequestSchema,
  BrowserNavigateRequestSchema,
  BrowserFrameSchema,
  BrowserRenderReceiptSchema,
  BrowserFrameAcknowledgmentSchema,
  BrowserDiagnosticSchema,
  BrowserErrorSchema,
  BrowserBindingSchema,
  BrowserCloseReceiptSchema,
  SemanticSnapshotV1Schema,
} from '../browser-schemas.js';
import {
  binding,
  reference,
  snapshot,
  maximumDiagnosticSummary,
} from './browser-schema-fixtures.js';

const requestId = reference(7);
const frame = {
  binding,
  viewerId: reference(10),
  frameId: reference(11),
  sequence: 4,
  width: 1280,
  height: 720,
  byteLength: 2000,
  format: 'jpeg',
};
const draw = {
  binding,
  viewerId: reference(10),
  frameId: reference(11),
  sequence: 4,
  stage: 'drawn',
  drawnAt: '2026-10-02T12:00:00.000Z',
};

// Wire claims are checked against each other; actual authentication, destination and drawing remain runtime gates.
it('keeps persistent and clean lifecycle separate and refuses actor/path/engine claims', () => {
  expect(
    BrowserOpenRequestSchema.safeParse({ requestId, mode: 'persistent', profileId: reference(12) })
      .success
  ).toBe(true);
  expect(BrowserOpenRequestSchema.safeParse({ requestId, mode: 'ephemeral' }).success).toBe(true);
  expect(
    BrowserOpenRequestSchema.safeParse({ requestId, mode: 'ephemeral', profileId: reference(12) })
      .success
  ).toBe(false);
  for (const field of [
    'actorId',
    'ownerId',
    'profilePath',
    'executablePath',
    'page',
    'cdp',
    'evaluation',
  ])
    expect(
      BrowserOpenRequestSchema.safeParse({
        requestId,
        mode: 'ephemeral',
        [field]: 'PRIVATE-SENTINEL',
      }).success,
      field
    ).toBe(false);
  expect(
    BrowserCloseReceiptSchema.safeParse({
      requestId,
      browserId: binding.browserId,
      browserGeneration: 0,
      cleanup: 'observed',
      reason: 'processesRemain',
    }).success
  ).toBe(false);
});
it('requires closed unique scoped grants without accepting caller identity', () => {
  const grant = {
    grantId: reference(12),
    grantRevision: 1,
    tabId: binding.tabId,
    attachment: { kind: 'room', roomId: reference(13) },
    permissions: ['browser.view'],
    expiresAt: '2026-10-02T12:00:00.000Z',
    revokedAt: null,
  };
  expect(BrowserGrantSchema.safeParse(grant).success).toBe(true);
  expect(
    BrowserGrantSchema.safeParse({ ...grant, permissions: ['browser.view', 'browser.view'] })
      .success
  ).toBe(false);
  expect(
    BrowserGrantSchema.safeParse({ ...grant, permissions: ['browser.evaluate'] }).success
  ).toBe(false);
  expect(
    BrowserGrantChangeRequestSchema.safeParse({
      grantId: grant.grantId,
      expectedRevision: 1,
      permissions: ['browser.control'],
      expiresAt: grant.expiresAt,
      actorId: reference(100),
    }).success
  ).toBe(false);
});
it('counts expanded click steps and UTF-8 text commits without allowing executable actions', () => {
  const click = { kind: 'click', x: 100, y: 100, button: 'left' };
  const request = {
    kind: 'input',
    requestId,
    binding,
    steps: Array.from({ length: 5 }, () => ({ ...click })),
  };
  expect(BrowserInputRequestSchema.safeParse(request).success).toBe(true);
  expect(
    BrowserInputRequestSchema.safeParse({ ...request, steps: [...request.steps, click] }).success
  ).toBe(false);
  expect(
    BrowserInputRequestSchema.safeParse({
      ...request,
      steps: [{ kind: 'text', text: '界'.repeat(682) }],
    }).success
  ).toBe(true);
  expect(
    BrowserInputRequestSchema.safeParse({
      ...request,
      steps: [{ kind: 'text', text: '界'.repeat(683) }],
    }).success
  ).toBe(false);
  for (const step of [
    { kind: 'evaluate', script: 'alert(1)' },
    { ...click, x: NaN },
    { kind: 'keyDown', key: 'Meta+R' },
    { kind: 'text', text: '\ud800' },
  ])
    expect(BrowserInputRequestSchema.safeParse({ ...request, steps: [step] }).success).toBe(false);
});
it('refuses oversized envelopes before schema parsing and rejects cycles, holes and accessors without invocation', () => {
  const huge = {
    kind: 'input',
    requestId,
    binding,
    steps: Array.from({ length: 16 }, () => ({ kind: 'text', text: 'x'.repeat(2048) })),
  };
  expect(BrowserInputRequestSchema.safeParse(huge).success).toBe(false);
  const cycle: Record<string, unknown> = {};
  cycle.cycle = cycle;
  expect(BrowserOpenRequestSchema.safeParse(cycle).success).toBe(false);
  expect(
    BrowserInputRequestSchema.safeParse({ kind: 'input', requestId, binding, steps: new Array(1) })
      .success
  ).toBe(false);
  let invoked = 0;
  const getter = Object.defineProperty({ ...binding }, 'epoch', {
    enumerable: true,
    get: () => {
      invoked++;
      return 0;
    },
  });
  expect(BrowserBindingSchema.safeParse(getter).success).toBe(false);
  const malicious = Object.defineProperty({ ...snapshot() }, 'nodes', {
    enumerable: true,
    get: () => {
      invoked++;
      return [];
    },
  });
  expect(SemanticSnapshotV1Schema.safeParse(malicious).success).toBe(false);
  expect(invoked).toBe(0);
});
it('allows syntactic HTTP navigation while refusing executable/file URLs and userinfo', () => {
  const request = { kind: 'navigate', requestId, binding };
  expect(
    BrowserNavigateRequestSchema.safeParse({ ...request, url: 'https://fixture.example/path' })
      .success
  ).toBe(true);
  for (const url of [
    'javascript:alert(1)',
    'file:///private/profile',
    'https://user:secret@fixture.example',
  ])
    expect(BrowserNavigateRequestSchema.safeParse({ ...request, url }).success).toBe(false);
});
it('rejects wrong viewer, frame, sequence and generation draw acknowledgments and non-drawn stages', () => {
  expect(BrowserFrameAcknowledgmentSchema.safeParse({ frame, receipt: draw }).success).toBe(true);
  for (const receipt of [
    { ...draw, viewerId: reference(30) },
    { ...draw, frameId: reference(30) },
    { ...draw, sequence: 3 },
    { ...draw, binding: { ...binding, epoch: 1 } },
    { ...draw, stage: 'received' },
  ])
    expect(BrowserFrameAcknowledgmentSchema.safeParse({ frame, receipt }).success).toBe(false);
  expect(BrowserFrameSchema.safeParse({ ...frame, byteLength: 2 * 1024 * 1024 + 1 }).success).toBe(
    false
  );
  expect(BrowserRenderReceiptSchema.safeParse({ ...draw, token: 'CREDENTIAL' }).success).toBe(
    false
  );
});
it('keeps diagnostic and error metadata free of generic payload/echo fields', () => {
  const diagnostic = {
    binding,
    capturedAt: draw.drawnAt,
    kind: 'network',
    code: 'redacted',
    count: 1,
    truncated: false,
    redacted: true,
  };
  expect(BrowserDiagnosticSchema.safeParse(diagnostic).success).toBe(true);
  for (const field of [
    'detail',
    'message',
    'url',
    'cookies',
    'headers',
    'text',
    'input',
    'stderr',
    'path',
  ]) {
    expect(
      BrowserDiagnosticSchema.safeParse({ ...diagnostic, [field]: 'SECRET' }).success,
      field
    ).toBe(false);
    expect(
      BrowserErrorSchema.safeParse({ version: 1, reason: 'inaccessible', [field]: 'SECRET' })
        .success,
      field
    ).toBe(false);
  }
});
it('constructs the capture factory without a facade back-edge and preserves legacy validators', async () => {
  const factory = await import('../browser-capture-schemas.js');
  const facade = await import('../browser-schemas.js');
  const independent = factory.createBrowserCaptureSchemas({
    binding: BrowserBindingSchema,
    frame: BrowserFrameSchema,
  });
  const envelope = {
    frame,
    geometry: {
      cssViewport: { width: 1280, height: 720 },
      raster: { width: 2560, height: 1440, format: 'jpeg' },
      scaleX: 2,
      scaleY: 2,
    },
    pointer: { x: 0, y: 0, revision: 0 },
  };
  expect(independent.BrowserFramePointerEnvelopeSchema.parse(envelope)).toEqual(
    facade.BrowserFramePointerEnvelopeSchema.parse(envelope)
  );
  expect(BrowserFrameSchema.parse(frame)).toEqual(frame);
  for (const changed of [
    { ...envelope, geometry: { ...envelope.geometry, scaleX: 1 } },
    { ...envelope, pointer: { x: 1280, y: 0, revision: 0 } },
    { ...envelope, pointer: { x: 0, y: 720, revision: 0 } },
  ])
    expect(facade.BrowserFramePointerEnvelopeSchema.safeParse(changed).success).toBe(false);
});
it('validates maximum-width summaries, ordering, closed fields and terminal interval coherence', async () => {
  const { BrowserDiagnosticSummarySchema } = await import('../browser-schemas.js');
  const max = Number.MAX_SAFE_INTEGER;
  const summary = maximumDiagnosticSummary();
  const entries = summary.entries;
  expect(BrowserDiagnosticSummarySchema.safeParse(summary).success).toBe(true);
  const serialized = new TextEncoder().encode(JSON.stringify(summary));
  expect(serialized.length).toBeLessThanOrEqual(266240);
  console.info(
    'CAPTURE45_MAXIMUM_SCHEMA_WIDTH',
    JSON.stringify({
      summaryBytes: serialized.length,
      containerBytes: new TextEncoder().encode(
        JSON.stringify(Array.from({ length: 16 }, () => summary))
      ).length,
      wrapperBytes: new TextEncoder().encode(JSON.stringify({ ...summary, entries: [] })).length,
    })
  );
  const wrapper = { ...summary, entries: [] };
  expect(new TextEncoder().encode(JSON.stringify(wrapper)).length).toBeLessThanOrEqual(4096);
  expect(
    new TextEncoder().encode(JSON.stringify(Array.from({ length: 16 }, () => summary))).length
  ).toBeLessThanOrEqual(4 * 1024 * 1024);
  for (const invalid of [
    { ...summary, subsequentEventsUncounted: false },
    { ...summary, entries: [entries[0], entries[0]] },
    { ...summary, interval: { startOffsetMs: max, endOffsetMs: max - 1 } },
    { ...summary, entries: [{ ...entries[0], url: 'SECRET' }] },
  ])
    expect(BrowserDiagnosticSummarySchema.safeParse(invalid).success).toBe(false);
});
it('serializes maximum-width geometry and refuses area, format and boundary mismatches', async () => {
  const { BrowserFramePointerEnvelopeSchema } = await import('../browser-schemas.js');
  const max = Number.MAX_SAFE_INTEGER;
  const binding = maximumDiagnosticSummary().binding;
  const envelope = {
    frame: {
      ...frame,
      binding,
      viewerId: 'V'.repeat(64),
      frameId: 'F'.repeat(64),
      sequence: max,
      width: 16384,
      height: 512,
      byteLength: 2097152,
    },
    geometry: {
      cssViewport: { width: 16384, height: 512 },
      raster: { width: 16384, height: 512, format: 'jpeg' },
      scaleX: 1,
      scaleY: 1,
    },
    pointer: { x: 16383.999999999998, y: 511.99999999999994, revision: max },
  };
  expect(BrowserFramePointerEnvelopeSchema.safeParse(envelope).success).toBe(true);
  const bytes = new TextEncoder().encode(JSON.stringify(envelope)).length;
  expect(bytes).toBeLessThanOrEqual(16384);
  console.info('CAPTURE45_GEOMETRY_WIDTH', JSON.stringify({ bytes }));
  for (const invalid of [
    {
      ...envelope,
      geometry: {
        ...envelope.geometry,
        raster: { width: 16384, height: 513, format: 'jpeg' },
        scaleY: 513 / 512,
      },
    },
    {
      ...envelope,
      geometry: { ...envelope.geometry, raster: { width: 16384, height: 512, format: 'png' } },
    },
    { ...envelope, pointer: { x: 16384, y: 0, revision: max } },
    { ...envelope, pointer: { x: 0, y: 512, revision: max } },
  ])
    expect(BrowserFramePointerEnvelopeSchema.safeParse(invalid).success).toBe(false);
  let invoked = 0;
  const malicious = Object.defineProperty({ ...envelope }, 'pointer', {
    enumerable: true,
    get: () => {
      invoked++;
      return null;
    },
  });
  expect(BrowserFramePointerEnvelopeSchema.safeParse(malicious).success).toBe(false);
  expect(invoked).toBe(0);
});
