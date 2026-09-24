/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { Catalog, CATALOG_SECTIONS } from '../Catalog';

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
