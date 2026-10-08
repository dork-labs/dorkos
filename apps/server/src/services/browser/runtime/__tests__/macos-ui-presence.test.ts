import { describe, expect, it, vi } from 'vitest';
import {
  classifyOriginalPresence,
  joinOriginalPresenceClose,
} from './macos-ui-presence.fixture.js';

const original = { pid: 123, birth: 'darwin-bsd-start:456:789' };
function observed() {
  return {
    requestId: 'original',
    control: original,
    subjects: 2,
    birthsQualified: true,
    dock: { coverage: 'OBSERVED', positiveControlIcons: 1, managedIcons: 0, candidateCount: 3 },
    switcher: {
      coverage: 'OBSERVED',
      positiveControlIcons: 1,
      managedIcons: 0,
      candidateCount: 3,
      ownedReleasesObserved: true,
    },
    foreground: { coverage: 'OBSERVED', managedActivations: 0, frontmost: original },
  };
}
describe('original OS evidence qualification (portable schema controls, not OS acceptance)', () => {
  it('does not infer switcher absence from a Dock/activation-policy positive', () => {
    const row = observed();
    row.switcher.coverage = 'UNVERIFIED';
    expect(classifyOriginalPresence(row)).toBe('UNVERIFIED');
  });
  it.each(['dock', 'switcher', 'foreground'] as const)(
    'refuses unavailable %s UI evidence',
    (scope) => {
      const row = observed();
      row[scope].coverage = 'UNVERIFIED';
      expect(classifyOriginalPresence(row)).toBe('UNVERIFIED');
    }
  );
  it('requires actual positive control in both UI inventories', () => {
    const row = observed();
    row.dock.positiveControlIcons = 0;
    expect(classifyOriginalPresence(row)).toBe('UNVERIFIED');
    row.dock.positiveControlIcons = 1;
    row.switcher.positiveControlIcons = 0;
    expect(classifyOriginalPresence(row)).toBe('UNVERIFIED');
  });
  it('refuses unknown birth and empty native cohorts', () => {
    const row = observed();
    row.birthsQualified = false;
    expect(classifyOriginalPresence(row)).toBe('UNVERIFIED');
    row.birthsQualified = true;
    row.subjects = 0;
    expect(classifyOriginalPresence(row)).toBe('UNVERIFIED');
  });
  it('requires observation of owned key release, not successful posting', () => {
    const row = observed();
    row.switcher.ownedReleasesObserved = false;
    expect(classifyOriginalPresence(row)).toBe('UNVERIFIED');
  });
  it.each(['dock', 'switcher'] as const)(
    'reports actual managed %s presence even with partial evidence',
    (scope) => {
      const row = observed();
      row[scope].managedIcons = 1;
      row[scope].coverage = 'UNVERIFIED';
      expect(classifyOriginalPresence(row)).toBe('FAIL');
    }
  );
  it('reports actual original managed foreground activation', () => {
    const row = observed();
    row.foreground.managedActivations = 1;
    expect(classifyOriginalPresence(row)).toBe('FAIL');
  });
  it('accepts only fully qualified synthetic schema control, never manufactures OS data', () => {
    expect(classifyOriginalPresence(observed())).toBe('OBSERVED');
  });
});

it.each([false, undefined])(
  'retains end failure %s while joining every original return and death observation',
  async (cause) => {
    let first: { value: unknown } | undefined;
    const capture = (value: unknown) => {
      first ??= { value };
    };
    let releaseChild!: () => void, releaseStderr!: () => void;
    const child = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    const stderr = new Promise<void>((resolve) => {
      releaseStderr = resolve;
    });
    const stdout = Promise.reject(new Error('later pipe'));
    void stdout.catch(() => {});
    const absence = vi.fn(async () => {
      throw new Error('later absence');
    });
    const retire = vi.fn(async () => {
      throw new Error('later retirement');
    });
    const owner = joinOriginalPresenceClose({
      end: () => {
        throw cause;
      },
      retire,
      returns: [child, stdout, stderr],
      absence,
      capture,
    });
    let returned = false;
    void owner.then(() => {
      returned = true;
    });
    try {
      await Promise.resolve();
      expect(first?.value).toBe(cause);
      expect(retire).toHaveBeenCalledOnce();
      expect(absence).not.toHaveBeenCalled();
      expect(returned).toBe(false);
      releaseChild();
      await Promise.resolve();
      expect(absence).not.toHaveBeenCalled();
      expect(returned).toBe(false);
      releaseStderr();
      await owner;
      expect(absence).toHaveBeenCalledOnce();
      expect(first).toEqual({ value: cause });
      expect(returned).toBe(true);
    } finally {
      releaseChild();
      releaseStderr();
      await owner;
    }
  }
);

it('keeps a real focused Dock chain diagnostic separate from authenticated switcher coverage', () => {
  const row = observed();
  const diagnostic = {
    ...row,
    switcher: {
      ...row.switcher,
      coverage: 'UNVERIFIED',
      focusedDockChainObserved: true,
      newFocusedElementObserved: true,
      focusedDepth: 3,
    },
  };
  expect(classifyOriginalPresence(diagnostic)).toBe('UNVERIFIED');
});
