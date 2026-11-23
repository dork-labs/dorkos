/**
 * Whether this page holds words the person typed that a reload would lose
 * (DOR-5086).
 *
 * A page too old to confirm from reloads by itself only when nothing typed is
 * at stake; otherwise the sheet offers a Reload button and says what it
 * clears. The check is deliberately coarse: any text field, text area or
 * editable region with something in it counts, a search box included. A
 * false "unsaved" costs one click; a false "saved" costs a lost draft.
 *
 * @module features/auth/model/unsaved-work
 */

/** Input types that hold no typed words. */
const NOT_TYPED = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'password',
  'radio',
  'range',
  'reset',
  'submit',
]);

/** Whether a `[contenteditable]` element takes typing, by its attribute when the DOM can't say. */
function editable(field: HTMLElement): boolean {
  if (field.isContentEditable) return true;
  const value = field.getAttribute('contenteditable');
  return value === '' || value === 'true' || value === 'plaintext-only';
}

/**
 * Whether any field outside `except` holds typed words. Password fields never
 * count: the browser offers to fill them again, and the sheet never reloads
 * with one of its own filled in.
 *
 * @param root - The document to look in, for tests.
 * @param except - A part of the page to leave out: the sheet itself.
 */
export function hasUnsavedWork(root: ParentNode = document, except?: Element | null): boolean {
  const fields = root.querySelectorAll<HTMLElement>('input, textarea, [contenteditable]');
  for (const field of fields) {
    if (except?.contains(field)) continue;
    if (field instanceof HTMLInputElement) {
      if (NOT_TYPED.has(field.type) || field.disabled || field.readOnly) continue;
      if (field.value.trim() !== '') return true;
    } else if (field instanceof HTMLTextAreaElement) {
      if (field.disabled || field.readOnly) continue;
      if (field.value.trim() !== '') return true;
    } else if (editable(field) && (field.textContent ?? '').trim() !== '') {
      return true;
    }
  }
  return false;
}
