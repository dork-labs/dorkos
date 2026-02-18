// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import { SpecViewerDialog } from '../ui/SpecViewerDialog';

// === Mocks ===

// Mock the Zustand app store so we can control viewingSpecPath
const mockSetViewingSpecPath = vi.fn();
let mockViewingSpecPath: string | null = null;

vi.mock('@/layers/shared/model', () => ({
  useAppStore: (
    selector: (s: {
      viewingSpecPath: string | null;
      setViewingSpecPath: typeof mockSetViewingSpecPath;
    }) => unknown
  ) =>
    selector({
      viewingSpecPath: mockViewingSpecPath,
      setViewingSpecPath: mockSetViewingSpecPath,
    }),
}));

// Mock apiClient
const mockApiGet = vi.fn();

vi.mock('@/layers/shared/lib', () => ({
  apiClient: {
    get: (...args: unknown[]) => mockApiGet(...args),
  },
}));

// Mock react-markdown to render content as plain text for easy assertions
vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));

// === Tests ===

describe('SpecViewerDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders nothing when viewingSpecPath is null', () => {
    mockViewingSpecPath = null;
    const { container } = render(<SpecViewerDialog />);
    expect(container.firstChild).toBeNull();
  });

  it('shows loading state while fetching', async () => {
    mockViewingSpecPath = 'specs/my-feature/01-ideation.md';
    // Never resolves so loading stays visible
    mockApiGet.mockReturnValue(new Promise(() => {}));

    render(<SpecViewerDialog />);

    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('renders markdown content after fetch resolves', async () => {
    mockViewingSpecPath = 'specs/my-feature/01-ideation.md';
    mockApiGet.mockResolvedValue({ content: '# Hello World' });

    render(<SpecViewerDialog />);

    await waitFor(() => {
      expect(screen.getByTestId('markdown')).toBeInTheDocument();
    });
    expect(screen.getByTestId('markdown').textContent).toBe('# Hello World');
  });

  it('shows error message when fetch fails', async () => {
    mockViewingSpecPath = 'specs/missing.md';
    mockApiGet.mockRejectedValue(new Error('HTTP 404: Not Found'));

    render(<SpecViewerDialog />);

    await waitFor(() => {
      expect(screen.getByText('HTTP 404: Not Found')).toBeInTheDocument();
    });
  });

  it('calls setViewingSpecPath(null) when close button is clicked', () => {
    mockViewingSpecPath = 'specs/my-feature/01-ideation.md';
    // Use a never-resolving promise to avoid act() warnings from async state updates
    mockApiGet.mockReturnValue(new Promise(() => {}));

    render(<SpecViewerDialog />);

    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    expect(mockSetViewingSpecPath).toHaveBeenCalledWith(null);
  });

  it('calls setViewingSpecPath(null) when backdrop is clicked', () => {
    mockViewingSpecPath = 'specs/my-feature/01-ideation.md';
    // Use a never-resolving promise to avoid act() warnings from async state updates
    mockApiGet.mockReturnValue(new Promise(() => {}));

    render(<SpecViewerDialog />);

    // Click the backdrop (role="presentation" element)
    fireEvent.click(screen.getByRole('presentation'));
    expect(mockSetViewingSpecPath).toHaveBeenCalledWith(null);
  });

  it('fetches the correct path from the API', async () => {
    mockViewingSpecPath = 'specs/pulse-scheduler/02-specification.md';
    mockApiGet.mockResolvedValue({ content: '# Spec' });

    render(<SpecViewerDialog />);

    await waitFor(() => {
      expect(mockApiGet).toHaveBeenCalledWith(
        '/files/specs/pulse-scheduler/02-specification.md'
      );
    });
  });

  it('displays the spec path in the dialog header', () => {
    mockViewingSpecPath = 'specs/my-feature/01-ideation.md';
    mockApiGet.mockReturnValue(new Promise(() => {}));

    render(<SpecViewerDialog />);

    expect(screen.getByText('specs/my-feature/01-ideation.md')).toBeInTheDocument();
  });
});
