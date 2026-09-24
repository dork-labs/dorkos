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
