/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { APP_LOGO_MAP } from '@dorkos/icons/app-logos';
import { ServiceMark } from '../ui/ServiceMark';

afterEach(cleanup);

const SERVER_LOGO = '/api/connectors/catalog/logos/zendesk';

function renderMark(props: Parameters<typeof ServiceMark>[0]) {
  const { container } = render(<ServiceMark {...props} />);
  return container.firstElementChild as HTMLElement;
}

describe('ServiceMark', () => {
  it('shows a popular app’s bundled mark on a white tile, even when the server has a logo', () => {
    const mark = renderMark({
      iconKey: 'GitHub',
      displayName: 'GitHub',
      logo: '/api/connectors/catalog/logos/github',
    });

    const img = mark.querySelector('img');
    expect(img).toHaveAttribute('src', APP_LOGO_MAP.github);
    expect(img).toHaveAttribute('alt', '');
    expect(mark).toHaveClass('bg-white');
    expect(mark).toHaveAttribute('aria-hidden');
  });

  it('shows the server’s kept logo for any other app', () => {
    const mark = renderMark({ iconKey: 'zendesk', displayName: 'Zendesk', logo: SERVER_LOGO });

    expect(mark.querySelector('img')).toHaveAttribute('src', SERVER_LOGO);
    expect(mark).toHaveClass('bg-white');
  });

  it('falls back to the letter tile when the logo fails to load, with no broken image left', () => {
    const mark = renderMark({ iconKey: 'zendesk', displayName: 'Zendesk', logo: SERVER_LOGO });

    fireEvent.error(mark.querySelector('img')!);

    const letter = document.body.firstElementChild!.firstElementChild as HTMLElement;
    expect(letter.querySelector('img')).toBeNull();
    expect(letter).toHaveTextContent('Z');
    expect(letter).not.toHaveClass('bg-white');
  });

  it('asks the server by service id when the caller has no catalog entry for the app', () => {
    const mark = renderMark({ iconKey: 'zendesk', displayName: 'Zendesk' });

    expect(mark.querySelector('img')).toHaveAttribute('src', SERVER_LOGO);
  });

  it('keeps the letter tile when the server has no logo for the app', () => {
    const mark = renderMark({ iconKey: 'bare', displayName: '  bare app' });

    fireEvent.error(mark.querySelector('img')!);

    const letter = document.body.firstElementChild!.firstElementChild as HTMLElement;
    expect(letter.querySelector('img')).toBeNull();
    expect(letter).toHaveTextContent('B');
    expect(letter).toHaveClass('bg-muted');
  });

  it('asks for nothing when the catalog lists the app without a logo', () => {
    const mark = renderMark({ iconKey: 'zendesk', displayName: 'Zendesk', logo: null });

    expect(mark.querySelector('img')).toBeNull();
    expect(mark).toHaveTextContent('Z');
  });

  it('never asks the server for an id no logo can be kept for', () => {
    const mark = renderMark({ iconKey: 'Odd.Slug', displayName: 'Odd' });

    expect(mark.querySelector('img')).toBeNull();
    expect(mark).toHaveTextContent('O');
  });

  it('draws the webhook glyph, which is not a brand, on the plain tile', () => {
    const mark = renderMark({ iconKey: 'webhook', displayName: 'Webhook' });

    expect(mark.querySelector('img')).toBeNull();
    expect(mark.querySelector('svg')).not.toBeNull();
    expect(mark).toHaveClass('bg-muted');
  });
});
