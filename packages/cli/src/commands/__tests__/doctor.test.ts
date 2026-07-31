/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const apiCall = vi.fn();
vi.mock('../../lib/api-client.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../lib/api-client.js')>('../../lib/api-client.js');
  return { ...actual, apiCall: (...args: unknown[]) => apiCall(...args) };
});

import { CheckResultSchema } from '@dorkos/shared/health-schemas';
import { parseDoctorArgs, gatherDeepResults, withCleanStdout } from '../doctor.js';
import { exitCodeFor } from '../doctor-render.js';

describe('parseDoctorArgs', () => {
  it('defaults both options off', () => {
    expect(parseDoctorArgs([])).toEqual({ json: false, deep: false });
  });

  it('reads --json and --deep in any order', () => {
    expect(parseDoctorArgs(['--deep', '--json'])).toEqual({ json: true, deep: true });
  });

  it('rejects an unknown option instead of ignoring it', () => {
    expect(() => parseDoctorArgs(['--verbose'])).toThrow(/Unknown option for 'doctor'/);
  });
});

describe('gatherDeepResults', () => {
  beforeEach(() => {
    apiCall.mockReset();
  });

  it('returns the server checks when DorkOS answers', async () => {
    apiCall.mockResolvedValue({
      checks: [{ label: 'Rooms remember their conversations', status: 'pass' }],
    });

    const results = await gatherDeepResults();

    expect(apiCall).toHaveBeenCalledWith('GET', '/api/health/deep');
    expect(results).toHaveLength(1);
    expect(CheckResultSchema.safeParse(results[0]).success).toBe(true);
  });

  it('degrades to one note — never a failure — when nothing is listening', async () => {
    apiCall.mockRejectedValue(
      new Error('Cannot reach DorkOS server at http://localhost:4242: fetch failed')
    );

    const results = await gatherDeepResults();

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe('info');
    expect(results[0]?.detail).toContain('DorkOS is not running');
    expect(exitCodeFor(results)).toBe(0);
  });

  it('says the running DorkOS is too old when the route is not there', async () => {
    const { ApiError } = await import('../../lib/api-client.js');
    apiCall.mockRejectedValue(new ApiError(404, { error: 'Not found' }));

    const results = await gatherDeepResults();

    expect(results[0]?.status).toBe('info');
    expect(results[0]?.detail).toContain('older than these checks');
    expect(exitCodeFor(results)).toBe(0);
  });

  it('passes any other error through in plain words, still without failing', async () => {
    apiCall.mockRejectedValue(new Error('This DorkOS instance did not accept your API key.'));

    const results = await gatherDeepResults();

    expect(results[0]?.status).toBe('info');
    expect(results[0]?.detail).toContain('did not accept your API key');
    expect(exitCodeFor(results)).toBe(0);
  });
});

describe('exitCodeFor', () => {
  it('is 0 for passes, notes, and warnings', () => {
    expect(
      exitCodeFor([
        { label: 'a', status: 'pass' },
        { label: 'b', status: 'warn' },
        { label: 'c', status: 'info' },
      ])
    ).toBe(0);
  });

  it('is 1 as soon as one check fails', () => {
    expect(
      exitCodeFor([
        { label: 'a', status: 'pass' },
        { label: 'b', status: 'fail' },
      ])
    ).toBe(1);
  });
});

describe('doctor --json output', () => {
  let written: string[];
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    written = [];
    spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    spy.mockRestore();
  });

  it('prints a JSON array of schema-valid results and nothing else', async () => {
    const { printJson } = await import('../../lib/operator-output.js');
    printJson([{ label: 'Node.js 24.0.0', status: 'pass' }]);

    const parsed: unknown = JSON.parse(written.join(''));
    expect(Array.isArray(parsed)).toBe(true);
    expect(CheckResultSchema.array().safeParse(parsed).success).toBe(true);
  });
});

describe('withCleanStdout', () => {
  it('sends what the work prints to stderr, and restores stdout after', async () => {
    const toStdout: string[] = [];
    const toStderr: string[] = [];
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      toStdout.push(String(chunk));
      return true;
    });
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      toStderr.push(String(chunk));
      return true;
    });
    try {
      const value = await withCleanStdout(async () => {
        process.stdout.write('noise from loading config\n');
        return 42;
      });
      expect(value).toBe(42);
      expect(toStdout).toEqual([]);
      expect(toStderr).toEqual(['noise from loading config\n']);

      // Restored: the payload that follows still goes to stdout.
      process.stdout.write('payload\n');
      expect(toStdout).toEqual(['payload\n']);
    } finally {
      outSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it('restores stdout even when the work throws', async () => {
    const before = process.stdout.write;
    await expect(
      withCleanStdout(async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(process.stdout.write).toBe(before);
  });
});
