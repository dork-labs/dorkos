/**
 * What an extension can reach, as every place that asks about it draws it
 * (DOR-2686): each line appears for its condition and not otherwise, a re-ask
 * leads with what is new, and long lists wrap rather than being cut short.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ExtensionPermissionLines } from '../ui/ExtensionPermissionLines';
import {
  approvedSetOf,
  extensionPermissionLines,
  permissionLineText,
  permissionsAddedSince,
  permissionViewFromRecord,
  runsAnyProgram,
  type ExtensionPermissionView,
} from '../lib/permission-lines';

/** The lead line every separate-runtime card carries. */
const SEPARATE = ['Runs separately from DorkOS.'];

const ISOLATED: ExtensionPermissionView = {
  runtime: 'subprocess',
  net: [],
  run: [],
  agents: false,
  hasPage: false,
};

/** The text of every line, in order. */
function linesOf(container: HTMLElement): string[] {
  return [...container.querySelectorAll('li')].map((li) => li.textContent ?? '');
}

afterEach(cleanup);

describe('ExtensionPermissionLines', () => {
  // Purpose: an in-process server half states full access, which already
  // covers its screens, and nothing else.
  it('states full access for a server half that runs inside DorkOS', () => {
    const { container } = render(
      <ExtensionPermissionLines
        permissions={{
          runtime: 'in-process',
          net: [],
          run: [],
          agents: false,
          hasPage: true,
          hasServer: true,
        }}
      />
    );
    expect(linesOf(container)).toEqual(['Runs inside DorkOS with full access to this computer.']);
  });

  // Purpose: screens only never claims full access to the computer.
  it('says only that its screens run with your access when it has no server half', () => {
    const { container } = render(
      <ExtensionPermissionLines
        permissions={{
          runtime: 'in-process',
          net: [],
          run: [],
          agents: false,
          hasPage: true,
          hasServer: false,
        }}
      />
    );
    expect(linesOf(container)).toEqual(['Its screens run in DorkOS with your access.']);
  });

  // Purpose: the narrowest isolated extension says it runs separately and
  // can't connect — and claims no programs, agents or screens.
  it('says it runs separately and cannot connect when it declares nothing', () => {
    const { container } = render(<ExtensionPermissionLines permissions={ISOLATED} />);
    expect(linesOf(container)).toEqual([...SEPARATE, 'Can’t connect to the internet.']);
  });

  // Purpose: each declared reach gets its line, and only then.
  it('lists hosts, programs, agent access and screens when declared', () => {
    const { container } = render(
      <ExtensionPermissionLines
        permissions={{
          ...ISOLATED,
          net: ['imap.fastmail.com', '*.googleapis.com'],
          run: [{ name: 'git', found: true }],
          agents: true,
          hasPage: true,
        }}
      />
    );
    expect(linesOf(container)).toEqual([
      ...SEPARATE,
      'Can connect to: imap.fastmail.com, *.googleapis.com',
      'Can run: git',
      'Can message your agents and start chats.',
      'Its screens run in DorkOS with your access.',
    ]);
  });

  // Purpose: a program not found here is still listed, with a note.
  it('notes a program that is not on this computer', () => {
    const { container } = render(
      <ExtensionPermissionLines
        permissions={{ ...ISOLATED, run: [{ name: 'git', found: false }] }}
      />
    );
    expect(linesOf(container)).toContain('Can run: git');
    expect(linesOf(container)).toContain('git isn’t on this computer.');
  });

  // Purpose: a refused program is never listed as runnable; the reason shows.
  it('names a refused program with why, never under "Can run"', () => {
    const { container } = render(
      <ExtensionPermissionLines
        permissions={{
          ...ISOLATED,
          run: [
            {
              name: 'helper',
              found: false,
              refusedReason: 'It sits in extension files, which could change without asking.',
            },
          ],
        }}
      />
    );
    expect(linesOf(container)).toContain(
      'helper can’t be allowed: It sits in extension files, which could change without asking.'
    );
    expect(linesOf(container).some((line) => line.startsWith('Can run'))).toBe(false);
  });

  // Purpose: a shell or interpreter gets the "can run any program" caution.
  it('warns that an interpreter can run any program', () => {
    const { container } = render(
      <ExtensionPermissionLines
        permissions={{
          ...ISOLATED,
          run: [
            { name: 'git', found: true },
            { name: '/bin/bash', found: true },
          ],
        }}
      />
    );
    const caution = container.querySelector('[data-line="run-anything:/bin/bash"]');
    expect(caution).toHaveTextContent('Can run /bin/bash, which can run any program.');
    expect(caution).toHaveAttribute('data-tone', 'warning');
    expect(linesOf(container)).toContain('Can run: git');
  });

  // Purpose: a re-ask leads with what is new, before where it runs.
  it('leads a re-ask with what is new', () => {
    const { container } = render(
      <ExtensionPermissionLines
        permissions={{ ...ISOLATED, net: ['a.example.com', 'api.example.com'], agents: true }}
        added={{ net: ['api.example.com'], run: ['git'], agents: true, runtime: false }}
      />
    );
    const lines = linesOf(container);
    expect(lines.slice(0, 3)).toEqual([
      'Now also wants to connect to: api.example.com',
      'Now also wants to run: git',
      'Now also wants to message your agents.',
    ]);
    // Then, before the lists, where it runs.
    expect(lines.slice(3, 4)).toEqual(SEPARATE);
  });

  // Purpose: moving back inside DorkOS is the widest change, said first.
  it('leads with a move back inside DorkOS', () => {
    const { container } = render(
      <ExtensionPermissionLines
        permissions={{ runtime: 'in-process', net: [], run: [], agents: false }}
        added={{ net: [], run: [], agents: false, runtime: true }}
      />
    );
    expect(linesOf(container)[0]).toBe('Now wants to run inside DorkOS with full access.');
  });

  // Purpose: a long host list is shown whole and wraps, never truncated.
  it('shows every host of a long list, wrapping', () => {
    const hosts = Array.from({ length: 40 }, (_, i) => `host-${i}.example.com`);
    render(<ExtensionPermissionLines permissions={{ ...ISOLATED, net: hosts }} />);
    const list = screen.getByText(hosts[0]!).parentElement!.parentElement!;
    expect(list).toHaveTextContent(hosts.join(', '));
    expect(list.className).toContain('break-all');
    expect(list.className).not.toMatch(/truncate|line-clamp/);
  });

  // Purpose: no set from the server (version skew) draws nothing at all.
  it('draws nothing without a set', () => {
    const { container } = render(<ExtensionPermissionLines permissions={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  // Purpose: every sentence stays within the app-copy cap of 15 words, names aside.
  it('keeps every sentence to 15 words or fewer', () => {
    const lines = extensionPermissionLines(
      {
        ...ISOLATED,
        net: ['a.example.com'],
        run: [
          { name: 'git', found: false },
          { name: 'pwsh', found: true },
          {
            name: 'x.cmd',
            found: false,
            refusedReason: 'Windows scripts (.cmd, .bat) need a shell, so they can’t run.',
          },
        ],
        agents: true,
        hasPage: true,
      },
      { net: ['b.example.com'], run: ['git'], agents: true, runtime: true }
    );
    for (const line of lines) {
      const body = line.parts.map((part) => (typeof part === 'string' ? part : 'name')).join('');
      expect(body.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length).toBeLessThan(16);
    }
  });
});

describe('permission-lines helpers', () => {
  // Purpose: interpreters are recognised by file name, any case, with .exe.
  it('recognises shells and interpreters by file name', () => {
    expect(runsAnyProgram('sh')).toBe(true);
    expect(runsAnyProgram('/usr/bin/python3')).toBe(true);
    expect(runsAnyProgram('C:\\Windows\\System32\\PowerShell.exe')).toBe(true);
    expect(runsAnyProgram('git')).toBe(false);
    expect(runsAnyProgram('nodemon')).toBe(false);
  });

  // Purpose: a record's view tells a missing program from a refused one, and
  // a record with no isolation field (older server) yields no view at all.
  it('builds the card view from a record', () => {
    const base = { bundleReady: true, hasServerEntry: false, hasDataProxy: false };
    expect(permissionViewFromRecord({ ...base, isolation: undefined })).toBeNull();
    expect(permissionViewFromRecord({ ...base, isolation: null })).toEqual({
      runtime: 'in-process',
      net: [],
      run: [],
      agents: false,
      hasServer: false,
    });
    expect(
      permissionViewFromRecord({ ...base, hasDataProxy: true, isolation: null })?.hasServer
    ).toBe(true);
    expect(
      permissionViewFromRecord({
        ...base,
        isolation: {
          runtime: 'subprocess',
          net: ['a.example.com'],
          run: ['git', 'helper'],
          resolvedRun: [
            { name: 'git', path: null, reason: 'Not found on this computer.' },
            { name: 'helper', path: null, reason: 'It sits in extension files.' },
          ],
          agents: false,
          memoryMb: 256,
        },
      })?.run
    ).toEqual([
      { name: 'git', found: false },
      { name: 'helper', found: false, refusedReason: 'It sits in extension files.' },
    ]);
  });

  // Purpose: the echo is exactly the declared set, program names only.
  it('echoes the set a card showed', () => {
    expect(approvedSetOf(null)).toBeUndefined();
    expect(
      approvedSetOf({ ...ISOLATED, net: ['a.example.com'], run: [{ name: 'git', found: false }] })
    ).toEqual({ runtime: 'subprocess', net: ['a.example.com'], run: ['git'], agents: false });
  });
});

describe('author-chosen names', () => {
  // Purpose: a host or program name with a direction override cannot reorder
  // the copy around it: every name is drawn in its own <bdi>.
  it('isolates hosts and program names', () => {
    const { container } = render(
      <ExtensionPermissionLines
        permissions={{
          ...ISOLATED,
          net: ['a.example.com', 'b.example.com'],
          run: [{ name: 'bash\u202e', found: true }],
        }}
      />
    );
    const isolated = [...container.querySelectorAll('bdi')].map((el) => el.textContent);
    expect(isolated).toEqual(['a.example.com', 'b.example.com', 'bash\u202e']);
  });
});

describe('what changed since a refused card', () => {
  const SEEN = {
    runtime: 'subprocess' as const,
    net: ['a.example.com'],
    run: ['git'],
    agents: false,
  };

  // Purpose: the redrawn card can lead with exactly what the refused one did not list.
  it('lists only what is new', () => {
    expect(
      permissionsAddedSince(SEEN, {
        ...SEEN,
        net: ['a.example.com', 'b.example.com'],
        agents: true,
      })
    ).toEqual({ net: ['b.example.com'], run: [], agents: true, runtime: false });
    expect(
      permissionsAddedSince(SEEN, { ...SEEN, runtime: 'in-process', net: [], run: [] })
    ).toEqual({ net: [], run: [], agents: false, runtime: true });
  });

  // Purpose: a narrower or equal set has nothing new to lead with.
  it('is null when nothing was added', () => {
    expect(permissionsAddedSince(SEEN, SEEN)).toBeNull();
    expect(permissionsAddedSince(SEEN, { ...SEEN, net: [] })).toBeNull();
  });

  // Purpose: the plain-text form reads names in place.
  it('reads a line as one sentence', () => {
    const [line] = extensionPermissionLines({
      ...ISOLATED,
      run: [{ name: 'sh', found: true }],
    }).filter((l) => l.key.startsWith('run-anything'));
    expect(permissionLineText(line!)).toBe('Can run sh, which can run any program.');
  });
});
