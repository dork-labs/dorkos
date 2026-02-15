const LINK_ID = 'google-fonts-link';

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

export function removeGoogleFont(): void {
  document.getElementById(LINK_ID)?.remove();
}

export function applyFontCSS(sans: string, mono: string): void {
  document.documentElement.style.setProperty('--font-sans', sans);
  document.documentElement.style.setProperty('--font-mono', mono);
}

export function removeFontCSS(): void {
  document.documentElement.style.removeProperty('--font-sans');
  document.documentElement.style.removeProperty('--font-mono');
}
