/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProjectPluginsNote } from '../ProjectPluginsNote';

describe('ProjectPluginsNote (DOR-4394)', () => {
  it('says why in fixed words, with a muted mark and no button', () => {
    render(<ProjectPluginsNote />);
    const note = screen.getByTestId('project-plugins-note');

    expect(note).toHaveTextContent('OpenCode can’t run in this project. It has its own plugins.');
    expect(note).toHaveTextContent(
      'DorkOS won’t run a project’s code without your yes. Allowing your own projects comes next.'
    );
    expect(note.querySelector('button')).toBeNull();
    expect(note.querySelector('svg')).toHaveClass('text-muted-foreground', 'size-4');
    expect(note).not.toHaveClass('border');
  });
});
