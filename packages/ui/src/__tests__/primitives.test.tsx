/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { createRef } from 'react';
import { Button, Field, FieldError, FieldLabel, Input, Notice } from '../index.js';

afterEach(cleanup);

describe('portable control contract', () => {
  // A reusable Button must not accidentally submit a surrounding form.
  it('keeps native buttons inert until a submit is explicit', () => {
    const submit = vi.fn();
    const { getByText } = render(
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Button>Cancel</Button>
        <Button type="submit">Save</Button>
      </form>
    );
    expect(getByText('Cancel')).toHaveAttribute('type', 'button');
    fireEvent.click(getByText('Cancel'));
    expect(submit).not.toHaveBeenCalled();
    fireEvent.click(getByText('Save'));
    expect(submit).toHaveBeenCalledTimes(1);
  });

  // Slot keeps the child's DOM identity and both click handlers when used as a link.
  it('composes Slot child events and refs without assigning an anchor a button type', () => {
    const click = vi.fn();
    const ref = createRef<HTMLAnchorElement>();
    const { getByRole } = render(
      <Button asChild onClick={click}>
        <a ref={ref} href="/team" onClick={click}>
          Team
        </a>
      </Button>
    );
    const link = getByRole('link');
    expect(ref.current).toBe(link);
    expect(link).not.toHaveAttribute('type');
    fireEvent.click(link);
    expect(click).toHaveBeenCalledTimes(2);
  });

  // Compact icon controls retain their baseline size and press behavior.
  it('keeps responsive sizes, disabled semantics, and reduced-motion press gating', () => {
    const { getByRole } = render(
      <Button size="icon-sm" disabled aria-label="More">
        +
      </Button>
    );
    const button = getByRole('button');
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('data-size', 'icon-sm');
    expect(button.className).toContain('size-10 md:size-8');
    expect(button.className).toContain('motion-safe:active:scale-[0.97]');
  });

  // Destructive foreground follows the package theme instead of a host white utility.
  it('uses the namespaced destructive foreground token', () => {
    const { getByRole } = render(<Button variant="destructive">Delete</Button>);
    expect(getByRole('button').className).toContain('text-dui-destructive-foreground');
    expect(getByRole('button').className).not.toContain('text-white');
  });

  // A focus ring at part strength fell under 3:1 on both themes (DOR-2567). Every variant keeps
  // a solid ring, and a label wrapping a hidden file input shows it when the input has focus.
  it('draws a solid focus ring on every variant, including around a wrapped input', () => {
    const variants = ['default', 'destructive', 'outline', 'secondary', 'ghost', 'brand', 'link'];
    for (const variant of variants) {
      const { getByRole, unmount } = render(
        <Button variant={variant as 'default'}>{variant}</Button>
      );
      const classes = getByRole('button').className.split(' ');
      const rings = classes.filter((name) =>
        /^(has-\[:focus-visible\]|focus-visible):ring-dui-/.test(name)
      );
      expect(rings.length, variant).toBeGreaterThan(0);
      expect(
        rings.filter((name) => name.includes('/')),
        variant
      ).toEqual([]);
      expect(
        classes.filter((name) => /^dui-dark:focus-visible:ring-/.test(name)),
        variant
      ).toEqual([]);
      unmount();
    }
    // A ring the same colour as the fill needs a gap to read as an edge.
    for (const variant of ['brand', 'destructive'] as const) {
      const { getByRole, unmount } = render(<Button variant={variant}>{variant}</Button>);
      const classes = getByRole('button').className.split(' ');
      for (const state of ['focus-visible', 'has-[:focus-visible]'])
        expect(classes, `${variant} ${state}`).toEqual(
          expect.arrayContaining([`${state}:ring-offset-2`, `${state}:ring-offset-dui-background`])
        );
      unmount();
    }
    const { getByRole: plain } = render(<Button variant="outline">Plain</Button>);
    expect(plain('button').className).not.toContain('ring-offset');
    cleanup();
    const { container } = render(
      <Button asChild variant="outline">
        <label>
          Attach
          <input type="file" className="sr-only" />
        </label>
      </Button>
    );
    const label = container.querySelector('label')!;
    expect(label.className).toContain('has-[:focus-visible]:ring-dui-ring');
    expect(label.className).toContain('has-[:focus-visible]:ring-[3px]');
  });

  // Label clicks and described-by references must reach real mounted elements.
  it('mounts a label, input and one deduplicated error with real IDs', () => {
    const { getByLabelText, getByRole } = render(
      <Field>
        <FieldLabel htmlFor="email">Email</FieldLabel>
        <Input id="email" aria-invalid aria-describedby="email-error" />
        <FieldError id="email-error" errors={[{ message: 'Required' }, { message: 'Required' }]} />
      </Field>
    );
    expect(getByLabelText('Email')).toHaveAttribute('aria-describedby', 'email-error');
    expect(getByRole('alert')).toHaveTextContent('Required');
    expect(getByRole('alert').textContent).toBe('Required');
  });

  // A message should create no unsolicited announcement except for an error.
  it('announces only errors by default and permits deliberate status', () => {
    const { getByText, getByRole } = render(
      <>
        <Notice tone="info">Hint</Notice>
        <Notice tone="success">Saved</Notice>
        <Notice tone="error">Failed</Notice>
        <Notice tone="success" role="status">
          Completed
        </Notice>
      </>
    );
    expect(getByText('Hint')).not.toHaveAttribute('role');
    expect(getByText('Saved')).not.toHaveAttribute('role');
    expect(getByRole('alert')).toHaveTextContent('Failed');
    expect(getByRole('status')).toHaveTextContent('Completed');
  });
});
