import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useTaskTemplateDialog } from '../model/use-task-template-dialog';
import type { TaskTemplate } from '@dorkos/shared/types';

const MOCK_TEMPLATE: TaskTemplate = {
  id: 'health-check',
  name: 'Health Check',
  description: 'Run lint, tests, and type-check to catch issues early.',
  prompt: 'Run the project health checks: lint, test, and typecheck.',
  cron: '0 8 * * 1',
  timezone: 'UTC',
};

describe('useTaskTemplateDialog', () => {
  beforeEach(() => {
    // Reset Zustand store between tests
    act(() => {
      useTaskTemplateDialog.setState({ pendingTemplate: null, externalTrigger: false });
    });
  });

  it('initialises with null pendingTemplate and externalTrigger=false', () => {
    const { result } = renderHook(() => useTaskTemplateDialog());
    expect(result.current.pendingTemplate).toBeNull();
    expect(result.current.externalTrigger).toBe(false);
  });

  it('openWithTemplate sets pendingTemplate and externalTrigger=true', () => {
    const { result } = renderHook(() => useTaskTemplateDialog());
    act(() => {
      result.current.openWithTemplate(MOCK_TEMPLATE);
    });
    expect(result.current.pendingTemplate).toEqual(MOCK_TEMPLATE);
    expect(result.current.externalTrigger).toBe(true);
  });

  it('clear resets pendingTemplate to null and externalTrigger to false', () => {
    const { result } = renderHook(() => useTaskTemplateDialog());
    act(() => {
      result.current.openWithTemplate(MOCK_TEMPLATE);
    });
    act(() => {
      result.current.clear();
    });
    expect(result.current.pendingTemplate).toBeNull();
    expect(result.current.externalTrigger).toBe(false);
  });

  it('calling openWithTemplate twice overwrites the previous template', () => {
    const OTHER: TaskTemplate = { ...MOCK_TEMPLATE, id: 'docs-sync', name: 'Docs Sync' };
    const { result } = renderHook(() => useTaskTemplateDialog());
    act(() => {
      result.current.openWithTemplate(MOCK_TEMPLATE);
    });
    act(() => {
      result.current.openWithTemplate(OTHER);
    });
    expect(result.current.pendingTemplate?.id).toBe('docs-sync');
  });
});
