/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { PackageReadme } from '../PackageReadme';

/**
 * A realistic README: a leading `# <name>` h1 (the shape that caused
 * DOR-725 — streamdown renders it as a real `<h1>` competing with the
 * page's own title), an h2 and h3, a fenced code block, and a table. The
 * code fence's syntax-highlighted spans resolve through a Suspense
 * boundary in real streamdown, so this test only asserts on the
 * synchronously-rendered heading tree — never on highlighted code content.
 */
const readme = [
  '# demo-package',
  '',
  'A short description of the package.',
  '',
  '## Usage',
  '',
  'Run it like this:',
  '',
  '```bash',
  'dorkos install demo-package',
  '```',
  '',
  '### Options',
  '',
  '| Option | Description |',
  '| --- | --- |',
  '| --verbose | Prints extra output |',
  '',
].join('\n');

describe('PackageReadme', () => {
  it('never renders a second <h1> — the README h1 is demoted to h2', () => {
    const { container } = render(<PackageReadme markdown={readme} />);
    expect(container.querySelectorAll('h1')).toHaveLength(0);
  });

  it('demotes each heading level by one tag (h1→h2, h2→h3, h3→h4)', () => {
    const { container } = render(<PackageReadme markdown={readme} />);
    expect(container.querySelector('h2')?.textContent).toBe('demo-package');
    expect(container.querySelector('h3')?.textContent).toBe('Usage');
    expect(container.querySelector('h4')?.textContent).toBe('Options');
  });

  it('keeps streamdown’s default heading rhythm (mt-6 mb-2 font-semibold) on every demoted heading', () => {
    // Regression guard: an earlier fix demoted headings by swapping in bare
    // tag-name strings, which skips streamdown's default heading renderer
    // entirely and drops its spacing classes — crowding the heading against
    // the paragraph above it. Pinning the classes here means that can't
    // silently come back.
    const { container } = render(<PackageReadme markdown={readme} />);
    const h2 = container.querySelector('h2');
    const h3 = container.querySelector('h3');
    const h4 = container.querySelector('h4');

    for (const heading of [h2, h3, h4]) {
      expect(heading?.classList.contains('mt-6')).toBe(true);
      expect(heading?.classList.contains('mb-2')).toBe(true);
      expect(heading?.classList.contains('font-semibold')).toBe(true);
    }

    // Sizes track streamdown's own default for the rendered tag, not the
    // README's original level — a demoted h1 looks like a real h2, etc.
    expect(h2?.classList.contains('text-2xl')).toBe(true);
    expect(h3?.classList.contains('text-xl')).toBe(true);
    expect(h4?.classList.contains('text-lg')).toBe(true);
  });

  it('still renders the code block and table content from the README', () => {
    const { container } = render(<PackageReadme markdown={readme} />);
    expect(container.querySelector('table')).toBeTruthy();
    expect(container.textContent).toContain('dorkos install demo-package');
    expect(container.textContent).toContain('Prints extra output');
  });
});
