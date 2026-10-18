/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const experiment = vi.hoisted(() => ({ enabled: false, paths: [] as string[] }));
vi.mock('@/layers/entities/config', () => ({
  useExperimentEnabledState: (path: string) => {
    experiment.paths.push(path);
    return { enabled: experiment.enabled, isLoading: false };
  },
}));

import { useDocEmbeds } from '../model/use-doc-embeds';
import { DOC_EMBEDS, DOC_EMBEDS_FOR_READERS } from '../ui/doc-embed-registry';

beforeEach(() => {
  experiment.enabled = false;
  experiment.paths = [];
});

describe('useDocEmbeds', () => {
  it('reads the Docs experiment', () => {
    renderHook(() => useDocEmbeds(true));
    expect(experiment.paths).toEqual(['docs.enabled']);
  });

  it('hands the editor nothing while Docs is off', () => {
    expect(renderHook(() => useDocEmbeds(true)).result.current).toBeUndefined();
    expect(renderHook(() => useDocEmbeds(false)).result.current).toBeUndefined();
  });

  it('hands an author the same validating registry on every render while Docs is on', () => {
    experiment.enabled = true;
    const { result, rerender } = renderHook(() => useDocEmbeds(true));
    expect(result.current).toBe(DOC_EMBEDS);
    rerender();
    expect(result.current).toBe(DOC_EMBEDS);
  });

  it('hands a reader the registry without diagnostics', () => {
    experiment.enabled = true;
    const registry = renderHook(() => useDocEmbeds(false)).result.current;
    expect(registry).toBe(DOC_EMBEDS_FOR_READERS);
    expect(Object.values(registry ?? {}).every((entry) => entry.validate === undefined)).toBe(true);
  });
});
