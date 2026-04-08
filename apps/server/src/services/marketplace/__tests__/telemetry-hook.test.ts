import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  _resetTelemetryReporter,
  registerTelemetryReporter,
  reportInstallEvent,
  type InstallEvent,
} from '../telemetry-hook.js';

const sampleEvent: InstallEvent = {
  packageName: 'code-review-suite',
  marketplace: 'dorkos-community',
  type: 'plugin',
  outcome: 'success',
  durationMs: 1234,
};

describe('telemetry-hook', () => {
  beforeEach(() => {
    _resetTelemetryReporter();
  });

  it('is a no-op when no reporter is registered', async () => {
    await expect(reportInstallEvent(sampleEvent)).resolves.toBeUndefined();
  });

  it('invokes the registered reporter with the event', async () => {
    const reporter = vi.fn().mockResolvedValue(undefined);
    registerTelemetryReporter(reporter);

    await reportInstallEvent(sampleEvent);

    expect(reporter).toHaveBeenCalledTimes(1);
    expect(reporter).toHaveBeenCalledWith(sampleEvent);
  });

  it('swallows errors thrown by the reporter', async () => {
    const reporter = vi.fn().mockRejectedValue(new Error('telemetry blew up'));
    registerTelemetryReporter(reporter);

    await expect(reportInstallEvent(sampleEvent)).resolves.toBeUndefined();
    expect(reporter).toHaveBeenCalledTimes(1);
  });

  it('clears the registered reporter via _resetTelemetryReporter', async () => {
    const reporter = vi.fn().mockResolvedValue(undefined);
    registerTelemetryReporter(reporter);

    _resetTelemetryReporter();
    await reportInstallEvent(sampleEvent);

    expect(reporter).not.toHaveBeenCalled();
  });
});
