import { describe, expect, it } from 'vitest';
import { probeAnswer, probeScript } from '../probe';

const M = '__DORKOS_TERMINAL_COMMAND__';

describe('probeAnswer', () => {
  it('reads only what is between the markers, whatever the startup files print', () => {
    expect(probeAnswer(`Welcome, Sam!\n${M}/Users/sam/.local/bin/dorkos\n${M}bye`)).toBe(
      '/Users/sam/.local/bin/dorkos'
    );
  });

  it('reads nothing found as an empty answer', () => {
    expect(probeAnswer(`${M}${M}`)).toBe('');
  });

  it('is null when the shell never got as far as asking', () => {
    expect(probeAnswer('zsh: bad option: -i')).toBeNull();
    expect(probeAnswer(`${M}/half`)).toBeNull();
  });
});

describe('probeScript', () => {
  it('asks command -v in zsh and bash, which prints an alias as its definition', () => {
    expect(probeScript('zsh')).toContain('command -v dorkos');
    expect(probeScript('bash')).toContain('command -v dorkos');
  });

  it('asks fish for its function first, since fish keeps aliases as functions', () => {
    expect(probeScript('fish')).toContain('functions -q dorkos');
  });
});
