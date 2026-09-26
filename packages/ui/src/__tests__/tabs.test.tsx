/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { createRef } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../tabs.js';

afterEach(cleanup);

describe('Tabs', () => {
  // Extracted wrappers must pass caller refs and activation events to Radix.
  it('forwards trigger/content refs and click events', () => {
    const triggerRef = createRef<HTMLButtonElement>();
    const contentRef = createRef<HTMLDivElement>();
    const clicked = vi.fn();
    render(
      <Tabs defaultValue="one">
        <TabsList>
          <TabsTrigger value="one">One</TabsTrigger>
          <TabsTrigger value="two" ref={triggerRef} onClick={clicked}>
            Two
          </TabsTrigger>
        </TabsList>
        <TabsContent value="one">First</TabsContent>
        <TabsContent value="two" ref={contentRef}>
          Second
        </TabsContent>
      </Tabs>
    );
    const two = screen.getByRole('tab', { name: 'Two' });
    expect(triggerRef.current).toBe(two);
    fireEvent.mouseDown(two, { button: 0, ctrlKey: false });
    fireEvent.click(two);
    expect(clicked).toHaveBeenCalledOnce();
    expect(contentRef.current).toBe(screen.getByRole('tabpanel'));
    expect(contentRef.current).toHaveTextContent('Second');
  });

  // Automatic activation remains the default when arrow keys move focus.
  it('activates the next tab with ArrowRight', async () => {
    render(
      <Tabs defaultValue="one">
        <TabsList>
          <TabsTrigger value="one">One</TabsTrigger>
          <TabsTrigger value="two">Two</TabsTrigger>
        </TabsList>
        <TabsContent value="one">First panel</TabsContent>
        <TabsContent value="two">Second panel</TabsContent>
      </Tabs>
    );
    const one = screen.getByRole('tab', { name: 'One' });
    one.focus();
    fireEvent.keyDown(one, { key: 'ArrowRight', code: 'ArrowRight' });
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Two' })).toHaveAttribute('data-state', 'active')
    );
    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveTextContent('Second panel');
    expect(panel).toHaveClass('motion-reduce:animate-none!');
  });

  // Manual mode requires an explicit activation after focus moves.
  it('keeps the current tab active in manual mode until Enter', () => {
    render(
      <Tabs defaultValue="one" activationMode="manual">
        <TabsList responsive={false}>
          <TabsTrigger value="one">One</TabsTrigger>
          <TabsTrigger value="two">Two</TabsTrigger>
        </TabsList>
        <TabsContent value="one">First</TabsContent>
        <TabsContent value="two">Second</TabsContent>
      </Tabs>
    );
    const one = screen.getByRole('tab', { name: 'One' });
    one.focus();
    fireEvent.keyDown(one, { key: 'ArrowRight' });
    expect(one).toHaveAttribute('data-state', 'active');
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Two' }), { key: 'Enter' });
    expect(screen.getByRole('tab', { name: 'Two' })).toHaveAttribute('data-state', 'active');
  });
});
