// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { NotificationSoundItem } from '../ui/NotificationSoundItem';

afterEach(() => {
  cleanup();
});

describe('NotificationSoundItem', () => {
  it('renders Volume2 icon when enabled', () => {
    render(<NotificationSoundItem enabled={true} onToggle={vi.fn()} />);
    const button = screen.getByRole('button', { name: 'Mute notification sound' });
    expect(button).toBeDefined();
  });

  it('renders VolumeOff icon when disabled', () => {
    render(<NotificationSoundItem enabled={false} onToggle={vi.fn()} />);
    const button = screen.getByRole('button', { name: 'Unmute notification sound' });
    expect(button).toBeDefined();
  });

  it('calls onToggle when clicked', () => {
    const onToggle = vi.fn();
    render(<NotificationSoundItem enabled={true} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole('button', { name: 'Mute notification sound' }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
