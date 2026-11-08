// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { BrowserHandoffCard } from '../ui/BrowserHandoffCard';

const motionState = vi.hoisted(() => ({ reduced: false, transitions: [] as unknown[] }));
vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
  useReducedMotion: () => motionState.reduced,
  motion: {
    div: ({ children, transition }: { children: ReactNode; transition: unknown }) => {
      motionState.transitions.push(transition);
      return <div>{children}</div>;
    },
  },
}));
vi.mock('../model/use-browser-handoff', () => ({
  useBrowserHandoff: () => ({
    handoff: { id: 'h1', site: 'northwind.example', agentName: 'Atlas', agentFolder: null },
    step: 'wall',
    canShowWindow: false,
    busy: false,
    error: null,
  }),
}));

afterEach(() => {
  cleanup();
  motionState.transitions.length = 0;
});

describe('the card’s motion', () => {
  it('matches the background task bar', () => {
    motionState.reduced = false;
    render(<BrowserHandoffCard sessionId="chat-one" />);
    expect(screen.getByText(/wants a person to continue/)).toBeTruthy();
    expect(motionState.transitions.at(-1)).toEqual({ duration: 0.35, ease: [0.16, 1, 0.3, 1] });
  });

  it('is instant under reduced motion', () => {
    motionState.reduced = true;
    render(<BrowserHandoffCard sessionId="chat-one" />);
    expect(motionState.transitions.at(-1)).toEqual({ duration: 0 });
  });
});
