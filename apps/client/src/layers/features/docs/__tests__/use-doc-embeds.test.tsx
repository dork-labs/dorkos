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
import { DOC_EMBEDS } from '../ui/doc-embed-registry';

beforeEach(() => {
  experiment.enabled = false;
  experiment.paths = [];
});

describe('useDocEmbeds', () => {
  it('reads the Docs experiment', () => {
    renderHook(() => useDocEmbeds());
    expect(experiment.paths).toEqual(['docs.enabled']);
  });

  it('hands the editor nothing while Docs is off', () => {
    expect(renderHook(() => useDocEmbeds()).result.current).toBeUndefined();
  });

  it('hands the editor the same registry on every render while Docs is on', () => {
    experiment.enabled = true;
    const { result, rerender } = renderHook(() => useDocEmbeds());
    expect(result.current).toBe(DOC_EMBEDS);
    rerender();
    expect(result.current).toBe(DOC_EMBEDS);
  });
});
