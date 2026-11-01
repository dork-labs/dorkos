/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { createRef, type FormEvent } from 'react';
import { Button, Field, FieldError, FieldLabel, Input, Notice } from '../index.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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
    expect(button.className).toContain('size-11 md:size-8');
    expect(button.className).toContain('motion-safe:active:scale-[0.97]');
  });

  // Destructive foreground follows the package theme instead of a host white utility.
  it('uses the namespaced destructive foreground token', () => {
    const { getByRole } = render(<Button variant="destructive">Delete</Button>);
    expect(getByRole('button').className).toContain('text-dui-destructive-foreground');
    expect(getByRole('button').className).not.toContain('text-white');
  });

  // One recipe on every variant: an outline with a transparent gap works on any ground and
  // survives forced colours, where a box-shadow ring vanishes. A label wrapping a hidden file
  // input shows it when the input has focus.
  it('draws one solid focus outline on every variant, including around a wrapped input', () => {
    const variants = ['primary', 'destructive', 'secondary', 'ghost', 'brand', 'link'] as const;
    for (const variant of variants) {
      const { getByRole, unmount } = render(<Button variant={variant}>{variant}</Button>);
      const classes = getByRole('button').className.split(' ');
      expect(classes, variant).toEqual(
        expect.arrayContaining([
          'outline-dui-ring',
          'focus-visible:outline-2',
          'focus-visible:outline-offset-2',
          'has-[:focus-visible]:outline-2',
          'has-[:focus-visible]:outline-offset-2',
        ])
      );
      expect(
        classes.filter((name) => /ring-/.test(name) && !name.includes('outline')),
        variant
      ).toEqual([]);
      // In Tailwind v4 this sets the style a later `outline-2` reads, so no ring would draw.
      expect(classes, variant).not.toContain('outline-none');
      unmount();
    }
    const { container } = render(
      <Button asChild variant="secondary">
        <label>
          Attach
          <input type="file" className="sr-only" />
        </label>
      </Button>
    );
    const label = container.querySelector('label')!;
    expect(label.className).toContain('has-[:focus-visible]:outline-2');
  });

  it('no variant carries a border or a shadow', () => {
    for (const variant of ['primary', 'secondary', 'ghost', 'destructive', 'brand'] as const) {
      const { getByRole, unmount } = render(<Button variant={variant}>{variant}</Button>);
      const classes = getByRole('button').className.split(' ');
      expect(
        classes.filter((name) => /^(border|shadow)(-|$)/.test(name)),
        variant
      ).toEqual([]);
      unmount();
    }
  });

  // The old names stay until Cloud has moved, and report the one vocabulary tests read.
  it('resolves the deprecated names to the same classes and the new data-variant', () => {
    const pairs = [
      ['default', 'primary'],
      ['outline', 'secondary'],
    ] as const;
    for (const [alias, name] of pairs) {
      const { getByRole, unmount } = render(<Button variant={alias}>Old</Button>);
      const button = getByRole('button');
      expect(button).toHaveAttribute('data-variant', name);
      const { getByText, unmount: unmountNew } = render(<Button variant={name}>New</Button>);
      expect(button.className).toBe(getByText('New').className);
      unmountNew();
      unmount();
    }
    const { getByRole } = render(<Button>Plain</Button>);
    expect(getByRole('button')).toHaveAttribute('data-variant', 'primary');
  });

  it('grows every size to a 44px target below md', () => {
    const sizes = {
      xs: 'h-11 md:h-6',
      sm: 'h-11 md:h-8',
      md: 'h-11 md:h-9',
      lg: 'h-12 md:h-10',
      'icon-xs': 'size-11 md:size-6',
      'icon-sm': 'size-11 md:size-8',
      'icon-md': 'size-11 md:size-9',
      'icon-lg': 'size-12 md:size-10',
    } as const;
    for (const [size, classes] of Object.entries(sizes)) {
      const { getByRole, unmount } = render(<Button size={size as keyof typeof sizes}>x</Button>);
      expect(getByRole('button').className, size).toContain(classes);
      unmount();
    }
  });

  it('keeps the box and adds a hit area when responsive is off', () => {
    const { getByRole } = render(
      <Button size="xs" responsive={false}>
        Filter
      </Button>
    );
    const button = getByRole('button');
    expect(button.className).not.toContain('h-11');
    expect(button.className).toContain('max-md:after:size-11');
  });

  describe('loading', () => {
    it('stays focusable, ignores clicks and reports busy', () => {
      const click = vi.fn();
      const { getByRole } = render(
        <Button loading loadingLabel="Saving…" onClick={click}>
          Save
        </Button>
      );
      const button = getByRole('button');
      button.focus();
      expect(button).not.toBeDisabled();
      expect(document.activeElement).toBe(button);
      expect(button).toHaveAttribute('aria-busy', 'true');
      expect(button).toHaveAttribute('aria-disabled', 'true');
      fireEvent.click(button);
      expect(click).not.toHaveBeenCalled();
    });

    it('does not submit its form while busy', () => {
      const submit = vi.fn((event: FormEvent) => event.preventDefault());
      const { getByRole } = render(
        <form onSubmit={submit}>
          <Button type="submit" loading loadingLabel="Saving…">
            Save
          </Button>
        </form>
      );
      fireEvent.click(getByRole('button'));
      expect(submit).not.toHaveBeenCalled();
    });

    // Both labels always hold the same grid cell, so the box is the wider of the two in both
    // states. Only which one is hidden changes, so the width cannot move.
    it('keeps both labels mounted so the width holds, and keeps a leading icon', () => {
      const icon = <svg data-testid="icon" />;
      const { container, rerender, getByTestId } = render(
        <Button loading={false} loadingLabel="Saving…">
          {icon}Save
        </Button>
      );
      const cells = () => [...container.querySelectorAll('button > span > span')];
      expect(cells().map((c) => c.textContent)).toEqual(['Save', 'Saving…']);
      expect(cells()[0]!.className).not.toContain('invisible');
      expect(cells()[1]!.className).toContain('invisible');
      rerender(
        <Button loading loadingLabel="Saving…">
          {icon}Save
        </Button>
      );
      expect(cells().map((c) => c.textContent)).toEqual(['Save', 'Saving…']);
      expect(cells()[0]!.className).toContain('invisible');
      expect(cells()[1]!.className).not.toContain('invisible');
      expect(getByTestId('icon').parentElement!.tagName).toBe('BUTTON');
    });

    it('names an icon-only button by its loading label', () => {
      const { getByRole } = render(
        <Button size="icon-sm" aria-label="Save" loading loadingLabel="Saving…">
          <svg />
        </Button>
      );
      expect(getByRole('button', { name: 'Saving…' }).className).toContain(
        '[&_svg]:motion-safe:animate-dui-breathe'
      );
    });
  });

  describe('disabledReason', () => {
    it('stays focusable, ignores clicks and shows the reason on focus', async () => {
      vi.stubGlobal(
        'ResizeObserver',
        class {
          observe() {}
          unobserve() {}
          disconnect() {}
        }
      );
      const click = vi.fn();
      const { getByRole, findAllByText } = render(
        <Button disabledReason="Connect Telegram first" onClick={click}>
          Send
        </Button>
      );
      const button = getByRole('button');
      expect(button).not.toBeDisabled();
      expect(button).toHaveAttribute('aria-disabled', 'true');
      fireEvent.click(button);
      expect(click).not.toHaveBeenCalled();
      fireEvent.focus(button);
      expect((await findAllByText('Connect Telegram first')).length).toBeGreaterThan(0);
    });
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
