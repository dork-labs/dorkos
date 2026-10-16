/**
 * The lightbox, driven the way a reader drives it: click a thumbnail, step
 * through the gallery, save a picture, close it, and land back where they were.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { getPrefersReducedMotion } from '@/test-setup';
import { ImageLightboxGroup, ImageLightboxTrigger, MarkdownImage } from '../index';
import { lightboxDownloadName, pictureFileName } from '../lightbox-image';

// The REAL motion library: the viewer awaits its animations, which the shared
// stand-in does not return. `skipAnimations` makes each one finish at once.
vi.mock('motion/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('motion/react')>()),
  useReducedMotion: getPrefersReducedMotion,
}));

beforeAll(async () => {
  const { MotionGlobalConfig } = await import('motion/react');
  MotionGlobalConfig.skipAnimations = true;
});

const PICTURES = [
  { src: '/pictures/one.png', alt: 'First picture' },
  { src: '/pictures/two.png', alt: 'Second picture' },
  { src: '/pictures/three.png', alt: 'Third picture' },
];

/** A message's worth of thumbnails, all in one gallery. */
function Gallery() {
  return (
    <ImageLightboxGroup>
      {PICTURES.map((picture) => (
        <ImageLightboxTrigger key={picture.src} image={picture}>
          <img src={picture.src} alt={picture.alt} />
        </ImageLightboxTrigger>
      ))}
    </ImageLightboxGroup>
  );
}

/** The thumbnail button around the picture with this name. */
function thumbnail(name: string): HTMLElement {
  return screen.getByRole('img', { name }).closest('button')!;
}

/** The picture the open viewer is showing. */
function shown(): HTMLImageElement {
  return within(screen.getByRole('dialog')).getByRole('img') as HTMLImageElement;
}

/** Let any animation and the state it ends in finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

async function openAt(name: string) {
  fireEvent.click(thumbnail(name));
  return screen.findByRole('dialog');
}

describe('ImageLightbox', () => {
  it('opens the clicked picture over the page, with where it sits in the gallery', async () => {
    render(<Gallery />);

    const dialog = await openAt('Second picture');

    expect(dialog).toHaveAccessibleName('Second picture');
    expect(shown()).toHaveAttribute('src', '/pictures/two.png');
    expect(within(dialog).getByText('2 of 3')).toBeInTheDocument();
  });

  it('closes on Escape and gives focus back to the thumbnail', async () => {
    render(<Gallery />);
    await openAt('First picture');

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(thumbnail('First picture')).toHaveFocus();
  });

  it('closes on a click outside the picture, and not on the picture itself', async () => {
    render(<Gallery />);
    const dialog = await openAt('First picture');

    // The zoom surface turns pointer events off on the picture, so "on the
    // picture" is decided by where the click is, not what it landed on.
    shown().getBoundingClientRect = () =>
      ({ left: 100, top: 100, right: 300, bottom: 200, width: 200, height: 100 }) as DOMRect;
    fireEvent.click(dialog, { clientX: 150, clientY: 150 });
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.click(dialog, { clientX: 20, clientY: 400 });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('closes from the close button', async () => {
    render(<Gallery />);
    await openAt('First picture');

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('steps with the arrow keys and stops at either end', async () => {
    render(<Gallery />);
    const dialog = await openAt('First picture');

    fireEvent.keyDown(dialog, { key: 'ArrowLeft' });
    await settle();
    expect(shown()).toHaveAttribute('src', '/pictures/one.png');
    expect(screen.getByText('1 of 3')).toBeInTheDocument();

    fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    await waitFor(() => expect(shown()).toHaveAttribute('src', '/pictures/two.png'));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowRight' });
    await waitFor(() => expect(shown()).toHaveAttribute('src', '/pictures/three.png'));
    expect(screen.getByText('3 of 3')).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowRight' });
    await settle();
    expect(shown()).toHaveAttribute('src', '/pictures/three.png');
  });

  it('closes after the slide when Escape lands mid-step', async () => {
    render(<Gallery />);
    const dialog = await openAt('First picture');

    fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    fireEvent.keyDown(dialog, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(thumbnail('Second picture')).toHaveFocus();
  });

  it('opens again after closing, at the picture clicked', async () => {
    render(<Gallery />);
    await openAt('First picture');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await openAt('Third picture');

    expect(shown()).toHaveAttribute('src', '/pictures/three.png');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowLeft' });
    await waitFor(() => expect(shown()).toHaveAttribute('src', '/pictures/two.png'));
  });

  it('steps with the side buttons, offering only the directions that exist', async () => {
    render(<Gallery />);
    await openAt('First picture');

    expect(screen.queryByRole('button', { name: 'Previous image' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next image' }));
    await waitFor(() => expect(shown()).toHaveAttribute('src', '/pictures/two.png'));

    fireEvent.click(screen.getByRole('button', { name: 'Previous image' }));
    await waitFor(() => expect(shown()).toHaveAttribute('src', '/pictures/one.png'));
  });

  it('returns focus to the thumbnail of the picture showing when it closed', async () => {
    render(<Gallery />);
    const dialog = await openAt('First picture');

    fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    await waitFor(() => expect(shown()).toHaveAttribute('src', '/pictures/two.png'));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

    await waitFor(() => expect(thumbnail('Second picture')).toHaveFocus());
  });

  it('keeps Tab inside the viewer while it is open', async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">Outside</button>
        <Gallery />
      </>
    );
    await openAt('First picture');

    for (let i = 0; i < 6; i += 1) {
      await user.tab();
      expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement);
    }
  });

  it('shows a picture with no gallery around it on its own, with no counter or arrows', async () => {
    render(
      <ImageLightboxTrigger image={PICTURES[0]!}>
        <img src={PICTURES[0]!.src} alt={PICTURES[0]!.alt} />
      </ImageLightboxTrigger>
    );

    await openAt('First picture');

    expect(screen.getByText('1 of 1')).toHaveClass('invisible');
    expect(screen.queryByRole('button', { name: 'Next image' })).not.toBeInTheDocument();
  });

  it('says so when a picture will not load', async () => {
    render(<Gallery />);
    await openAt('First picture');

    fireEvent.error(shown());

    expect(await screen.findByText('This image couldn’t be loaded.')).toBeInTheDocument();
  });

  it('keeps its events from reaching the message row around it', async () => {
    const onRowKeyDown = vi.fn();
    const onRowContextMenu = vi.fn();
    render(
      <div role="toolbar" onKeyDown={onRowKeyDown} onContextMenu={onRowContextMenu}>
        <Gallery />
      </div>
    );
    const dialog = await openAt('First picture');

    fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    fireEvent.contextMenu(shown());

    expect(onRowKeyDown).not.toHaveBeenCalled();
    expect(onRowContextMenu).not.toHaveBeenCalled();
  });
});

describe('ImageLightbox — download', () => {
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  let clicked: HTMLAnchorElement[] = [];

  beforeEach(() => {
    clicked = [];
    click.mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this);
    });
    URL.createObjectURL = vi.fn(() => 'blob:picture');
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(() => {
    click.mockRestore();
  });

  it('saves the picture under its own name, from memory', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, blob: async () => new Blob(['png']) }))
    );
    render(
      <ImageLightboxTrigger
        image={{ src: '/api/rooms/r/attachments/a1', alt: 'Chart', downloadName: 'chart.png' }}
      >
        <img src="/api/rooms/r/attachments/a1" alt="Chart" />
      </ImageLightboxTrigger>
    );
    await openAt('Chart');

    fireEvent.click(screen.getByRole('button', { name: 'Download image' }));

    await waitFor(() => expect(clicked).toHaveLength(1));
    expect(fetch).toHaveBeenCalledWith('/api/rooms/r/attachments/a1');
    expect(clicked[0]!.href).toBe('blob:picture');
    expect(clicked[0]!.download).toBe('chart.png');
    expect(clicked[0]!.target).toBe('');
  });

  it('falls back to the plain link, in a new tab, when the bytes cannot be fetched', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      })
    );
    render(<Gallery />);
    await openAt('Second picture');

    fireEvent.click(screen.getByRole('button', { name: 'Download image' }));

    await waitFor(() => expect(clicked).toHaveLength(1));
    expect(clicked[0]!.getAttribute('href')).toBe('/pictures/two.png');
    expect(clicked[0]!.download).toBe('two.png');
    expect(clicked[0]!.target).toBe('_blank');
  });
});

describe('lightboxDownloadName', () => {
  it('prefers the name the host gave', () => {
    expect(lightboxDownloadName({ src: '/x/1', alt: '', downloadName: 'shot.png' })).toBe(
      'shot.png'
    );
  });

  it('uses the file name at the end of the address', () => {
    expect(lightboxDownloadName({ src: '/api/uploads/my%20shot.jpg?cwd=x', alt: '' })).toBe(
      'my shot.jpg'
    );
  });

  it('falls back to "image" for an address that names an id', () => {
    expect(lightboxDownloadName({ src: '/api/sessions/s/images/01JABC', alt: '' })).toBe('image');
  });

  it('names a data: picture by its type', () => {
    expect(lightboxDownloadName({ src: 'data:image/jpeg;base64,AAAA', alt: '' })).toBe('image.jpg');
  });
});

describe('pictureFileName', () => {
  it('takes the extension from the bytes, whatever the uploader named it', () => {
    expect(pictureFileName('invoice.html', 'image/png')).toBe('invoice.png');
  });

  it('keeps a picture extension when the type is unknown, and replaces any other', () => {
    expect(pictureFileName('chart.jpeg')).toBe('chart.jpeg');
    expect(pictureFileName('invoice.html')).toBe('invoice.png');
    expect(pictureFileName('image')).toBe('image.png');
  });
});

describe('MarkdownImage', () => {
  it('says a picture is not available rather than offering a broken one', () => {
    render(<MarkdownImage src="https://example.com/gone.png" alt="A chart" />);

    fireEvent.error(screen.getByRole('img', { name: 'A chart' }));

    expect(screen.getByText('A chart, not available')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('opens the lightbox from a Markdown picture', () => {
    render(<MarkdownImage src="https://example.com/a.png" alt="A chart" />);

    expect(screen.getByRole('img', { name: 'A chart' }).closest('button')).toHaveAttribute(
      'aria-haspopup',
      'dialog'
    );
  });

  it('stays a plain picture inside a link, so the link keeps its click', () => {
    render(
      <a href="https://example.com">
        <MarkdownImage src="https://example.com/badge.png" alt="Build passing" />
      </a>
    );

    expect(screen.getByRole('img', { name: 'Build passing' }).closest('button')).toBeNull();
  });
});
