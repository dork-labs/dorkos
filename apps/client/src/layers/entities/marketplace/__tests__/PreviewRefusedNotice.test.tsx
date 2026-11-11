/**
 * The refusal notice draws an app's "can’t be installed" headline in bold
 * (designer, DOR-3293), and every other reason as plain text.
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { PreviewRefusedNotice } from '../ui/PreviewRefusedNotice';

afterEach(cleanup);

/** A refusal as the server sends it. */
function refusal(errors: string[]) {
  return Object.assign(new Error('Package failed validation'), {
    status: 400,
    body: { error: 'Package failed validation', errors },
  });
}

describe('PreviewRefusedNotice', () => {
  it('draws an app’s headline in bold, then the rest of the sentence', () => {
    render(
      <PreviewRefusedNotice
        error={refusal([
          'Quarterly report can’t be installed. It names another app in a way DorkOS doesn’t accept. Ask its maker for an update.',
        ])}
      />
    );
    const headline = screen.getByText('Quarterly report can’t be installed.');
    expect(headline.tagName).toBe('STRONG');
    expect(headline.closest('li')).toHaveTextContent(
      'Quarterly report can’t be installed. It names another app in a way DorkOS doesn’t accept. Ask its maker for an update.'
    );
  });

  it('draws any other reason as plain text', () => {
    render(<PreviewRefusedNotice error={refusal(['It ships its own settings file.'])} />);
    expect(screen.getByText('It ships its own settings file.').tagName).toBe('LI');
    expect(document.querySelector('strong')).toBeNull();
  });
});
