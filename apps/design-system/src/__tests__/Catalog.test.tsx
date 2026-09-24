/** @vitest-environment jsdom */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { Catalog, CATALOG_SECTIONS } from '../Catalog';

// jsdom has no layout observer; computed layout is covered by the built browser suite.
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  }
);
afterAll(() => vi.unstubAllGlobals());

afterEach(cleanup);

describe('standalone catalog', () => {
  // Every registered destination must be a real mounted section, not an empty link.
  it('renders every catalog section and a link back to the client playground', () => {
    const { container } = render(<Catalog playgroundUrl="https://example.test/dev" />);
    for (const section of CATALOG_SECTIONS) {
      expect(container.querySelector(`#${section.id}`)).toHaveTextContent(section.title);
      expect(screen.getByRole('link', { name: section.title })).toHaveAttribute(
        'href',
        `#${section.id}`
      );
    }
    expect(screen.getByRole('link', { name: 'Client playground' })).toHaveAttribute(
      'href',
      'https://example.test/dev'
    );
  });

  // Extraction is incomplete if a portable family has no production example.
  it('offers every migrated primitive family as a navigable example', () => {
    const { container } = render(<Catalog playgroundUrl="/dev" />);
    for (const id of [
      'textarea',
      'checkbox',
      'radio-group',
      'switch',
      'slider',
      'tabs',
      'collapsible',
      'progress',
      'scroll-area',
      'dialog',
      'alert-dialog',
      'sheet',
      'popover',
      'hover-card',
      'tooltip',
      'select',
      'dropdown-menu',
      'context-menu',
      'portal-themes',
    ]) {
      expect(container.querySelector(`#${id}`), id).not.toBeNull();
      expect(container.querySelector(`nav a[href="#${id}"]`), id).not.toBeNull();
    }
  });

  it('clears a validation error when the email becomes valid', () => {
    render(<Catalog playgroundUrl="/dev" />);
    const input = screen.getByRole('textbox', { name: 'Email address' });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    fireEvent.change(input, { target: { value: 'kai@example.test' } });
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(screen.queryByText('Enter a valid email address.')).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'invalid' } });
    expect(input).toHaveAttribute('aria-invalid', 'true');
  });

  it('mounts a real production primitive in every migrated family', () => {
    const { container } = render(<Catalog playgroundUrl="/dev" />);
    for (const [id, slot] of [
      ['textarea', 'textarea'],
      ['checkbox', 'checkbox'],
      ['radio-group', 'radio-group'],
      ['switch', 'switch'],
      ['slider', 'slider'],
      ['tabs', 'tabs'],
      ['collapsible', 'collapsible'],
      ['progress', 'progress'],
      ['scroll-area', 'scroll-area'],
      ['dialog', 'dialog-trigger'],
      ['alert-dialog', 'alert-dialog-trigger'],
      ['sheet', 'sheet-trigger'],
      ['popover', 'popover-trigger'],
      ['hover-card', 'hover-card-trigger'],
      ['tooltip', 'tooltip-trigger'],
      ['select', 'select-trigger'],
      ['dropdown-menu', 'dropdown-menu-trigger'],
      ['context-menu', 'context-menu-trigger'],
    ]) {
      expect(
        container.querySelector(`#${id} [data-slot="${slot}"]`),
        `${id} must render its production control`
      ).not.toBeNull();
    }
  });

  // Theme selection must be explicit and reversible without storing app state.
  it('switches among light, dark and system on the catalog root', () => {
    const { container } = render(<Catalog playgroundUrl="/dev" />);
    const root = container.querySelector('[data-catalog-theme]');
    expect(root).toHaveAttribute('data-catalog-theme', 'system');
    fireEvent.click(screen.getByRole('button', { name: 'Dark theme' }));
    expect(root).toHaveClass('dark');
    fireEvent.click(screen.getByRole('button', { name: 'Light theme' }));
    expect(root).toHaveClass('light');
    expect(root).not.toHaveClass('dark');
    fireEvent.click(screen.getByRole('button', { name: 'System theme' }));
    expect(root).not.toHaveClass('light', 'dark');
  });

  // Real package Button and Slot examples must keep form and link semantics.
  it('shows native, submit, Slot and disabled button behavior', () => {
    render(<Catalog playgroundUrl="/dev" />);
    const cancel = screen.getByRole('button', { name: 'Cancel example' });
    expect(cancel).toHaveAttribute('type', 'button');
    fireEvent.click(cancel);
    expect(screen.queryByText('Example submitted')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Submit example' }));
    expect(screen.getByText('Example submitted')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Slotted link example' })).toHaveAttribute(
      'data-slot',
      'button'
    );
    expect(screen.getByRole('button', { name: 'Disabled example' })).toBeDisabled();
  });

  // Field messages need a mounted target and Notice must announce only errors.
  it('mounts labelled inputs, a described error and one alert', () => {
    render(<Catalog playgroundUrl="/dev" />);
    expect(screen.getByRole('textbox', { name: 'Email address' })).toHaveAttribute(
      'aria-describedby',
      'catalog-email-error'
    );
    expect(screen.getByText('Enter a valid email address.')).toHaveAttribute(
      'id',
      'catalog-email-error'
    );
    expect(
      within(screen.getByRole('region', { name: 'Notices' })).getAllByRole('alert')
    ).toHaveLength(1);
    expect(screen.getByText('Saved changes.')).not.toHaveAttribute('role');
  });
});
