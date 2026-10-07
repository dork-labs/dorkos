import { describe, expect, it } from 'vitest';
import { captureOriginalSupervisorCloseDiagnostic } from '../lifecycle/supervisor-close-diagnostic.js';

describe('original supervisor close diagnostics', () => {
  it('captures exact receiver and member once; emits fixed codes without text', () => {
    let reads = 0;
    const rows: string[] = [];
    const owner = {
      diagnostics() {
        expect(this).toBe(owner);
        reads++;
        return 'SUPERVISOR_CLOSE: SUPERVISOR_AUTH_ACK_UNOBSERVED\nSUPERVISOR_CLOSE: private token secret\nSUPERVISOR_CHILD_RETURN: CHILD_EXIT_FAILED\n';
      },
    };
    const report = captureOriginalSupervisorCloseDiagnostic(owner, (value) => rows.push(value));
    owner.diagnostics = () => {
      throw new Error('replacement');
    };
    report();
    report();
    expect(reads).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('SUPERVISOR_AUTH_ACK_UNOBSERVED');
    expect(rows[0]).toContain('CHILD_EXIT_FAILED');
    expect(rows[0]).toContain('other');
    expect(rows[0]).not.toContain('secret');
  });
  it.each([false, undefined])('isolates original getter/read/sink failures %s', (value) => {
    const getter = {
      get diagnostics(): () => string {
        throw value;
      },
    };
    expect(() =>
      captureOriginalSupervisorCloseDiagnostic(getter, () => {
        throw value;
      })()
    ).not.toThrow();
    expect(() =>
      captureOriginalSupervisorCloseDiagnostic({
        diagnostics() {
          throw value;
        },
      })()
    ).not.toThrow();
  });
  it('bounds rows and refuses oversized producer output', () => {
    const rows: string[] = [];
    captureOriginalSupervisorCloseDiagnostic(
      { diagnostics: () => 'SUPERVISOR_CLOSE: SUPERVISOR_AUTH_ACK_UNOBSERVED\n'.repeat(30) },
      (value) => rows.push(value)
    )();
    expect(JSON.parse(rows[0]!.slice(rows[0]!.indexOf('{'))).rows).toHaveLength(16);
    captureOriginalSupervisorCloseDiagnostic({ diagnostics: () => 'x'.repeat(262145) }, (value) =>
      rows.push(value)
    )();
    expect(rows[1]).toContain('invalid');
    expect(rows[1]).not.toContain('xxxxx');
  });
  it('reserves before a reentrant sink', () => {
    let calls = 0;
    const report = captureOriginalSupervisorCloseDiagnostic({ diagnostics: () => '' }, () => {
      calls++;
      report();
    });
    report();
    expect(calls).toBe(1);
  });
});
