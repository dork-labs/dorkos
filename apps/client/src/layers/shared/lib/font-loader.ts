const LINK_ID = 'google-fonts-link';

/** Inject or update a Google Fonts stylesheet link in the document head. */
export function loadGoogleFont(url: string): void {
  let link = document.getElementById(LINK_ID) as HTMLLinkElement | null;
  if (link) {
    link.href = url;
  } else {
    link = document.createElement('link');
    link.id = LINK_ID;
    link.rel = 'stylesheet';
    link.href = url;
    document.head.appendChild(link);
  }
}

/** Remove the Google Fonts stylesheet link from the document head. */
export function removeGoogleFont(): void {
  document.getElementById(LINK_ID)?.remove();
}

/** Set the `--font-sans` and `--font-mono` CSS custom properties on the document root. */
export function applyFontCSS(sans: string, mono: string): void {
  document.documentElement.style.setProperty('--font-sans', sans);
  document.documentElement.style.setProperty('--font-mono', mono);
}

/** Remove the `--font-sans` and `--font-mono` CSS custom properties from the document root. */
export function removeFontCSS(): void {
  document.documentElement.style.removeProperty('--font-sans');
  document.documentElement.style.removeProperty('--font-mono');
}
