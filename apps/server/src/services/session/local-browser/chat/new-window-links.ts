/** Runs in the page on the already-observed DOM identity. No destination is copied from page text. */
export function retargetNewWindowLink(element: Element): boolean {
  const link = element.closest('a[href],area[href]');
  if (!link) return false;
  const target =
    link.getAttribute('target') ??
    element.ownerDocument.querySelector('base[target]')?.getAttribute('target') ??
    '';
  if (!target || target.toLowerCase() === '_self') return false;
  link.setAttribute('target', '_self');
  return true;
}
