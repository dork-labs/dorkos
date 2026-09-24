/** @vitest-environment jsdom */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { createRef } from 'react';
import { UiProvider } from '../ui-provider.js';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '../popover.js';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../hover-card.js';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../tooltip.js';

const hosts: HTMLElement[] = [];
beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});
afterEach(() => {
  cleanup();
  for (const host of hosts) host.remove();
  hosts.length = 0;
});
function host() {
  const element = document.createElement('div');
  document.body.append(element);
  hosts.push(element);
  return element;
}

describe('floating overlays', () => {
  it('opens a Popover, routes content to its provider, and returns focus on Escape', async () => {
    const provided = host();
    render(
      <UiProvider portalContainer={provided}>
        <Popover>
          <PopoverTrigger>Filters</PopoverTrigger>
          <PopoverContent>
            <button>Choose</button>
          </PopoverContent>
        </Popover>
      </UiProvider>
    );
    const trigger = screen.getByRole('button', { name: 'Filters' });
    trigger.focus();
    fireEvent.click(trigger);
    const content = await screen.findByRole('dialog');
    expect(provided).toContainElement(content);
    expect(content).toHaveClass('w-72', 'motion-reduce:animate-none!');
    fireEvent.keyDown(content, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it('keeps a nested popover in the same provider host without dismissing its parent', async () => {
    const provided = host();
    render(
      <UiProvider portalContainer={provided}>
        <Popover>
          <PopoverTrigger>Outer</PopoverTrigger>
          <PopoverContent>
            <Popover>
              <PopoverTrigger>Inner</PopoverTrigger>
              <PopoverContent>Nested choices</PopoverContent>
            </Popover>
          </PopoverContent>
        </Popover>
      </UiProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Outer' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Inner' }));
    expect(provided).toContainElement(await screen.findByText('Nested choices'));
    expect(provided.querySelectorAll('[data-slot="popover-content"]')).toHaveLength(2);
  });

  it('renders a real heading and forwards its ref and native heading props', async () => {
    const ref = createRef<HTMLHeadingElement>();
    render(
      <Popover open>
        <PopoverTrigger>Details</PopoverTrigger>
        <PopoverContent>
          <PopoverTitle ref={ref} id="detail-heading">
            Filter details
          </PopoverTitle>
        </PopoverContent>
      </Popover>
    );
    const title = await screen.findByRole('heading', { level: 2, name: 'Filter details' });
    expect(ref.current).toBe(title);
    expect(title).toHaveAttribute('id', 'detail-heading');
  });

  it('keeps HoverCard trigger refs and a caller-controlled card in the provider host', async () => {
    const provided = host();
    const triggerRef = createRef<HTMLAnchorElement>();
    render(
      <UiProvider portalContainer={provided}>
        <HoverCard open>
          <HoverCardTrigger asChild>
            <a ref={triggerRef} href="#profile">
              Profile
            </a>
          </HoverCardTrigger>
          <HoverCardContent>Profile details</HoverCardContent>
        </HoverCard>
      </UiProvider>
    );
    expect(triggerRef.current).toBe(screen.getByRole('link', { name: 'Profile' }));
    const content = await screen.findByText('Profile details');
    expect(provided).toContainElement(content);
    expect(content).toHaveClass('w-64', 'motion-reduce:animate-none!');
    expect(content).toHaveAttribute('data-slot', 'hover-card-content');
  });

  it('forwards HoverCard openDelay rather than opening immediately on pointer enter', () => {
    vi.useFakeTimers();
    try {
      const onOpenChange = vi.fn();
      render(
        <HoverCard openDelay={300} onOpenChange={onOpenChange}>
          <HoverCardTrigger>Delayed profile</HoverCardTrigger>
          <HoverCardContent>Profile details</HoverCardContent>
        </HoverCard>
      );
      fireEvent.pointerEnter(screen.getByText('Delayed profile'), { pointerType: 'mouse' });
      expect(onOpenChange).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(299));
      expect(onOpenChange).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(1));
      expect(onOpenChange).toHaveBeenCalledWith(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps Tooltip delay and arrow while routing its label to the provider host', async () => {
    const provided = host();
    render(
      <UiProvider portalContainer={provided}>
        <TooltipProvider delayDuration={0}>
          <Tooltip open>
            <TooltipTrigger>Help</TooltipTrigger>
            <TooltipContent>Helpful detail</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </UiProvider>
    );
    const content = await screen.findByRole('tooltip');
    expect(provided).toContainElement(content);
    expect(content).toHaveTextContent('Helpful detail');
    expect(content).toHaveClass('motion-reduce:animate-none!');
    expect(content.querySelector('svg')).not.toBeNull();
  });
});
