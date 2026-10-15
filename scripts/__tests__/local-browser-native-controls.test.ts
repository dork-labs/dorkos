import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { assertBuiltPayloads } from '../local-browser/native/build-inputs.js';
const controls = createRequire(import.meta.url)('../local-browser/native/mock-controls.cjs') as {
  runMockControls(): Promise<Record<string, boolean>>;
};
describe('native artifact protocol controls', () => {
  it('refuses a runtime-passed candidate whose payload differs from the frozen normal build', () => {
    const frozen = { 'apps/desktop/dist/main/index.js': 'current-build' };
    expect(() =>
      assertBuiltPayloads(frozen, {
        payloads: { 'dist/main/index.js': { sha256: 'stale-candidate' } },
      })
    ).toThrow('Candidate differs');
    expect(
      assertBuiltPayloads(frozen, {
        payloads: { 'dist/main/index.js': { sha256: 'current-build' } },
      })
    ).toBe(1);
  });
  it('runs the actual serialized callbacks and refuses unsafe admissions without native work', async () => {
    const result = await controls.runMockControls();
    expect(result).toMatchObject({
      executedNative: false,
      maintainedCallsitesAudited: true,
      rawCallbacksVerbatim: true,
      cleanupWindowDisconnectRefused: true,
      unexpectedDisconnectPermanent: true,
      lateAckPermanent: true,
      secondForkRejectedBeforeOriginal: true,
      invalidEnvironmentPermanent: true,
      replacedWrapperNoDummyRead: true,
      postGuardRefusals: true,
    });
  });
});
