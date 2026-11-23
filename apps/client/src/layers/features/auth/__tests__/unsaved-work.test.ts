/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest';
import { hasUnsavedWork } from '../model/unsaved-work';

afterEach(() => {
  document.body.innerHTML = '';
});

function add(html: string): HTMLElement {
  const holder = document.createElement('div');
  holder.innerHTML = html;
  document.body.append(holder);
  return holder;
}

describe('hasUnsavedWork (DOR-5086)', () => {
  it('finds nothing on a page with empty fields', () => {
    add('<input type="text"><textarea></textarea><div contenteditable="true"></div>');
    expect(hasUnsavedWork()).toBe(false);
  });

  it('counts a typed text field, text area or editable region', () => {
    const input = add('<input type="search">').querySelector('input')!;
    input.value = 'made-up search';
    expect(hasUnsavedWork()).toBe(true);
    document.body.innerHTML = '';
    add('<textarea>made-up draft</textarea>');
    expect(hasUnsavedWork()).toBe(true);
    document.body.innerHTML = '';
    add('<div contenteditable="true">made-up note</div>');
    expect(hasUnsavedWork()).toBe(true);
  });

  it('never counts a password, a checkbox, a read-only field or the part it is told to skip', () => {
    const holder = add(
      '<input type="password" value="made-up"><input type="checkbox" checked>' +
        '<input type="text" value="shown" readonly><div contenteditable="false">text</div>'
    );
    expect(hasUnsavedWork()).toBe(false);
    const sheet = add('<textarea>typed in the sheet</textarea>');
    expect(hasUnsavedWork(document, sheet)).toBe(false);
    expect(holder.isConnected).toBe(true);
  });
});
