import { describe, it, expect } from 'vitest';
import {
  DEVTOOLS_PORT_FILE,
  parseListeningPorts,
  readDevToolsPort,
  refusalProblems,
  type LaunchObservation,
} from '../smoke-launch-switches';

/** A launch that refused cleanly; each test changes one thing. */
const refused: LaunchObservation = {
  exitCode: 1,
  exitSignal: null,
  timedOut: false,
  wroteDevToolsPortFile: false,
  listeningPorts: [],
};

describe('refusalProblems', () => {
  it('passes a launch that exited non-zero with nothing open', () => {
    expect(refusalProblems(refused)).toEqual([]);
  });

  it('fails a launch that exited 0', () => {
    expect(refusalProblems({ ...refused, exitCode: 0 })).toEqual(['it exited 0']);
  });

  it('fails a launch still running at the deadline', () => {
    expect(refusalProblems({ ...refused, exitCode: null, timedOut: true })).toEqual([
      'it was still running after 10 s',
    ]);
  });

  it('fails a launch that died on a signal', () => {
    expect(refusalProblems({ ...refused, exitCode: null, exitSignal: 'SIGSEGV' })).toEqual([
      'it died on SIGSEGV instead of exiting',
    ]);
  });

  it('fails a launch that exited non-zero but opened the port first', () => {
    expect(
      refusalProblems({ ...refused, wroteDevToolsPortFile: true, listeningPorts: [53111] })
    ).toEqual([`it wrote ${DEVTOOLS_PORT_FILE}`, 'it listened on port 53111']);
  });
});

describe('readDevToolsPort', () => {
  it('reads the port on the first line', () => {
    expect(readDevToolsPort('53111\n/devtools/browser/abc\n')).toBe(53111);
  });

  it('answers null for a file with no port', () => {
    expect(readDevToolsPort('')).toBeNull();
    expect(readDevToolsPort('/devtools/browser/abc')).toBeNull();
  });
});

describe('parseListeningPorts', () => {
  it('reads the ports off lsof -Fn name lines', () => {
    expect(parseListeningPorts('p123\nf21\nn127.0.0.1:53111\nf22\nn[::1]:53112\n')).toEqual([
      53111, 53112,
    ]);
  });

  it('answers nothing for empty output', () => {
    expect(parseListeningPorts('')).toEqual([]);
  });
});
