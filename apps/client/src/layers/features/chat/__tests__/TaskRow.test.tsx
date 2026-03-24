import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import { TaskRow } from '../ui/TaskRow';
import type { TaskItem } from '@dorkos/shared/types';

afterEach(cleanup);

const baseProps = {
  isBlocked: false,
  isExpanded: false,
  onToggleExpand: vi.fn(),
  onHover: vi.fn(),
  isHighlightedAsDep: false,
  isHighlightedAsDependent: false,
  taskMap: new Map<string, TaskItem>(),
  statusSince: null,
  isCelebrating: false,
  onScrollToTask: vi.fn(),
};

const pendingTask: TaskItem = { id: '1', subject: 'Pending task', status: 'pending' };
const activeTask: TaskItem = { id: '2', subject: 'Active task', status: 'in_progress' };
const doneTask: TaskItem = { id: '3', subject: 'Done task', status: 'completed' };

describe('TaskRow', () => {
  it('renders task subject', () => {
    render(<TaskRow task={pendingTask} {...baseProps} />);
    expect(screen.getByText('Pending task')).toBeDefined();
  });

  it('applies bold styling to in-progress tasks', () => {
    render(<TaskRow task={activeTask} {...baseProps} />);
    const row = screen.getByRole('button');
    expect(row.className).toContain('font-medium');
  });

  it('applies line-through to completed tasks', () => {
    render(<TaskRow task={doneTask} {...baseProps} />);
    const row = screen.getByRole('button');
    expect(row.className).toContain('line-through');
  });

  it('dims blocked pending tasks', () => {
    render(<TaskRow task={pendingTask} {...baseProps} isBlocked={true} />);
    const row = screen.getByRole('button');
    expect(row.className).toContain('text-muted-foreground/50');
  });

  it('calls onToggleExpand when clicked', () => {
    const onToggle = vi.fn();
    render(<TaskRow task={pendingTask} {...baseProps} onToggleExpand={onToggle} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it('toggles on Enter key', () => {
    const onToggle = vi.fn();
    render(<TaskRow task={pendingTask} {...baseProps} onToggleExpand={onToggle} />);
    fireEvent.keyDown(screen.getByRole('button'), { key: 'Enter' });
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it('has correct aria-expanded attribute', () => {
    render(<TaskRow task={pendingTask} {...baseProps} isExpanded={true} />);
    expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('true');
  });

  it('applies blue border when highlighted as dependency', () => {
    render(<TaskRow task={pendingTask} {...baseProps} isHighlightedAsDep={true} />);
    const row = screen.getByRole('button');
    expect(row.className).toContain('border-blue-400');
  });

  it('applies amber border when highlighted as dependent', () => {
    render(<TaskRow task={pendingTask} {...baseProps} isHighlightedAsDependent={true} />);
    const row = screen.getByRole('button');
    expect(row.className).toContain('border-amber-400');
  });

  it('calls onHover with task id on mouse enter', () => {
    const onHover = vi.fn();
    render(<TaskRow task={pendingTask} {...baseProps} onHover={onHover} />);
    fireEvent.mouseEnter(screen.getByRole('button'));
    expect(onHover).toHaveBeenCalledWith('1');
  });

  it('calls onHover with null on mouse leave', () => {
    const onHover = vi.fn();
    render(<TaskRow task={pendingTask} {...baseProps} onHover={onHover} />);
    fireEvent.mouseLeave(screen.getByRole('button'));
    expect(onHover).toHaveBeenCalledWith(null);
  });

  it('renders data-task-id attribute', () => {
    render(<TaskRow task={pendingTask} {...baseProps} />);
    expect(screen.getByRole('button').getAttribute('data-task-id')).toBe('1');
  });
});
