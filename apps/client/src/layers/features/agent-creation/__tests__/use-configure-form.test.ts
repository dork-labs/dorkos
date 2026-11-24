/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useConfigureForm } from '../model/use-configure-form';
import type { WizardStep } from '../lib/wizard-types';

// The hook reaches for a transport (the `.dork` conflict probe) and the config
// query (the default agent directory). Neither has anything to say about the
// seeding this file is about, so both answer with nothing.
const { browseDirectory } = vi.hoisted(() => ({ browseDirectory: vi.fn() }));
vi.mock('@/layers/shared/model', () => ({
  useTransport: () => ({ browseDirectory }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: undefined }),
}));

// Stubbed only so the entity barrel — and the real QueryClient singleton behind
// it — stays out of this file. The key's shape is nobody's business here: the
// query above never runs, and spelling the real config key by hand is exactly
// what `one-config-query-key.test.ts` forbids outside the factory that owns it.
vi.mock('@/layers/entities/config', () => ({
  configKeys: { current: () => ['stub-config-key'] },
}));

interface Props {
  step: WizardStep;
  templateName: string | null;
  faceSeed?: string;
}

/** Render the hook with a props object the test can change between renders. */
function drive(initial: Props) {
  return renderHook((props: Props) => useConfigureForm(props), { initialProps: initial });
}

beforeEach(() => {
  vi.clearAllMocks();
  browseDirectory.mockRejectedValue(new Error('ENOENT'));
});

describe('useConfigureForm — the folder probe', () => {
  it('blocks Create when the system refuses DorkOS the folder (forbidden)', async () => {
    browseDirectory.mockRejectedValue(
      Object.assign(new Error('DorkOS isn’t allowed to read that folder.'), {
        status: 403,
        code: 'forbidden',
      })
    );
    const { result } = drive({ step: 'naming', templateName: '@dork-labs/reviewer' });
    act(() => result.current.setDirectoryOverride('/work/reviewer'));
    await waitFor(() => expect(result.current.conflictStatus).toBe('error'));
    expect(result.current.canSubmit).toBe(false);
  });

  it('reads a missing folder as free to create (not_found)', async () => {
    browseDirectory.mockRejectedValue(
      Object.assign(new Error('That folder doesn’t exist.'), { status: 404, code: 'not_found' })
    );
    const { result } = drive({ step: 'naming', templateName: '@dork-labs/reviewer' });
    act(() => result.current.setDirectoryOverride('/work/reviewer'));
    await waitFor(() => expect(result.current.conflictStatus).toBe('no-path'));
  });
});

describe('useConfigureForm — seeding survives a reset (DOR-1558)', () => {
  it('re-fills the name after a reset when the same template is picked again', () => {
    const { result, rerender } = drive({ step: 'gallery', templateName: null });

    // Pick a template and walk into naming: the name is filled from it.
    rerender({ step: 'naming', templateName: '@dork-labs/reviewer' });
    expect(result.current.displayName).toBe('reviewer');
    expect(result.current.canSubmit).toBe(true);

    // Cancel: the dialog resets the form and returns to the gallery.
    act(() => result.current.reset());
    rerender({ step: 'gallery', templateName: null });
    expect(result.current.displayName).toBe('');

    // Re-enter on the SAME template. Before the fix the seeding guard still
    // remembered the first pass, so the field stayed empty and Create never
    // enabled — the wizard was uncompletable.
    rerender({ step: 'naming', templateName: '@dork-labs/reviewer' });
    expect(result.current.displayName).toBe('reviewer');
    expect(result.current.canSubmit).toBe(true);
  });

  it('re-seeds the face after a reset when design-your-own is picked again', () => {
    const { result, rerender } = drive({ step: 'gallery', templateName: null, faceSeed: '🧠' });

    rerender({ step: 'naming', templateName: null, faceSeed: '🧠' });
    expect(result.current.icon).toBe('🧠');

    act(() => result.current.reset());
    rerender({ step: 'gallery', templateName: null, faceSeed: '🧠' });
    expect(result.current.icon).toBe('');

    rerender({ step: 'naming', templateName: null, faceSeed: '🧠' });
    expect(result.current.icon).toBe('🧠');
  });
});
