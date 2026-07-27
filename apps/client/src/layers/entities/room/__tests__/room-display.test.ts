import { describe, it, expect } from 'vitest';
import { directMessageTitle } from '../lib/room-display';

describe('directMessageTitle', () => {
  it('names a one-to-one after the agent it is with', () => {
    expect(directMessageTitle(['Ana'])).toBe('Ana');
  });

  it('joins two with "and"', () => {
    expect(directMessageTitle(['Ana', 'Bo'])).toBe('Ana and Bo');
  });

  it('lists three in full', () => {
    expect(directMessageTitle(['Ana', 'Bo', 'Cy'])).toBe('Ana, Bo and Cy');
  });

  it('counts the rest past three, rather than running off a sidebar row', () => {
    expect(directMessageTitle(['Ana', 'Bo', 'Cy', 'Di'])).toBe('Ana, Bo, Cy and 1 other');
    expect(directMessageTitle(['Ana', 'Bo', 'Cy', 'Di', 'Ed'])).toBe('Ana, Bo, Cy and 2 others');
  });

  it('keeps the order it was given, which is the order they were picked', () => {
    expect(directMessageTitle(['Bo', 'Ana'])).toBe('Bo and Ana');
  });

  it('answers empty for nobody, which no caller should reach', () => {
    expect(directMessageTitle([])).toBe('');
  });
});
