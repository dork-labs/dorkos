// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ModelSubstitutedRow } from '../ModelSubstitutedRow';

describe('ModelSubstitutedRow', () => {
  it('names both models by their display names and where to change it (DOR-2636)', () => {
    render(<ModelSubstitutedRow fromName="Opus" toName="Suggested" />);
    expect(screen.getByTestId('model-substituted-row')).toHaveTextContent(
      'DorkOS credits don’t cover Opus, so this ran on Suggested. Switch in the model menu.'
    );
  });
});
