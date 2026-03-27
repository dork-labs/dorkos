// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { TunnelSettings } from '../ui/TunnelSettings';

// Mock motion/react so AnimatePresence renders immediately
vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: new Proxy(
    {},
    {
      get: (_target, prop: string) => {
        return ({ children, ...rest }: Record<string, unknown>) => {
          const htmlProps: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(rest)) {
            if (
              ![
                'variants',
                'initial',
                'animate',
                'exit',
                'transition',
                'onAnimationComplete',
              ].includes(k)
            ) {
              htmlProps[k] = v;
            }
          }
          const Tag = prop as keyof React.JSX.IntrinsicElements;
          // @ts-expect-error — dynamic tag rendering for test mock
          return <Tag {...htmlProps}>{children}</Tag>;
        };
      },
    }
  ),
}));

afterEach(() => {
  cleanup();
});

const defaultProps = {
  authToken: '',
  tokenError: null as string | null,
  showTokenInput: false,
  onAuthTokenChange: vi.fn(),
  onSaveToken: vi.fn().mockResolvedValue(undefined),
  onShowTokenInput: vi.fn(),
  domain: '',
  onDomainChange: vi.fn(),
  onDomainSave: vi.fn(),
};

/** Click the Settings toggle to expand the panel. */
async function expandSettings() {
  await userEvent.click(screen.getByText('Settings'));
}

describe('TunnelSettings', () => {
  describe('collapsed state', () => {
    it('renders the settings toggle button', () => {
      render(<TunnelSettings {...defaultProps} />);
      expect(screen.getByText('Settings')).toBeInTheDocument();
    });

    it('shows status chips when collapsed', () => {
      render(<TunnelSettings {...defaultProps} />);
      expect(screen.getByText('Token')).toBeInTheDocument();
      expect(screen.getByText('No domain')).toBeInTheDocument();
    });

    it('shows domain in chip when domain is set', () => {
      render(<TunnelSettings {...defaultProps} domain="my.ngrok.app" />);
      expect(screen.getByText('my.ngrok.app')).toBeInTheDocument();
    });
  });

  describe('auth token', () => {
    it('shows "Token saved" state when showTokenInput is false', async () => {
      render(<TunnelSettings {...defaultProps} />);
      await expandSettings();
      expect(screen.getByText('Token saved')).toBeInTheDocument();
    });

    it('calls onShowTokenInput when Change button is clicked', async () => {
      const onShowTokenInput = vi.fn();
      render(<TunnelSettings {...defaultProps} onShowTokenInput={onShowTokenInput} />);
      await expandSettings();
      await userEvent.click(screen.getByText('Change'));
      expect(onShowTokenInput).toHaveBeenCalledOnce();
    });

    it('shows token input field when showTokenInput is true', async () => {
      render(<TunnelSettings {...defaultProps} showTokenInput />);
      await expandSettings();
      expect(screen.getByLabelText('Auth token')).toBeInTheDocument();
    });

    it('Save button is disabled when authToken is empty', async () => {
      render(<TunnelSettings {...defaultProps} showTokenInput />);
      await expandSettings();
      expect(screen.getByText('Save')).toBeDisabled();
    });

    it('Save button is enabled when authToken has a value', async () => {
      render(<TunnelSettings {...defaultProps} showTokenInput authToken="abc123" />);
      await expandSettings();
      expect(screen.getByText('Save')).toBeEnabled();
    });

    it('calls onSaveToken when Save button is clicked', async () => {
      const onSaveToken = vi.fn().mockResolvedValue(undefined);
      render(
        <TunnelSettings
          {...defaultProps}
          showTokenInput
          authToken="abc"
          onSaveToken={onSaveToken}
        />
      );
      await expandSettings();
      await userEvent.click(screen.getByText('Save'));
      expect(onSaveToken).toHaveBeenCalledOnce();
    });

    it('displays the token error message when tokenError is set', async () => {
      render(<TunnelSettings {...defaultProps} showTokenInput tokenError="Invalid token" />);
      await expandSettings();
      expect(screen.getByText('Invalid token')).toBeInTheDocument();
    });

    it('calls onAuthTokenChange when the auth token input changes', async () => {
      const onAuthTokenChange = vi.fn();
      render(
        <TunnelSettings {...defaultProps} showTokenInput onAuthTokenChange={onAuthTokenChange} />
      );
      await expandSettings();
      await userEvent.type(screen.getByLabelText('Auth token'), 'x');
      expect(onAuthTokenChange).toHaveBeenCalled();
    });
  });

  describe('custom domain', () => {
    it('renders the custom domain input', async () => {
      render(<TunnelSettings {...defaultProps} />);
      await expandSettings();
      expect(screen.getByLabelText('Custom domain')).toBeInTheDocument();
    });

    it('calls onDomainSave when domain input loses focus', async () => {
      const onDomainSave = vi.fn();
      render(<TunnelSettings {...defaultProps} onDomainSave={onDomainSave} />);
      await expandSettings();
      fireEvent.blur(screen.getByLabelText('Custom domain'));
      expect(onDomainSave).toHaveBeenCalledOnce();
    });

    it('calls onDomainSave when Enter is pressed in the domain input', async () => {
      const onDomainSave = vi.fn();
      render(<TunnelSettings {...defaultProps} onDomainSave={onDomainSave} />);
      await expandSettings();
      fireEvent.keyDown(screen.getByLabelText('Custom domain'), { key: 'Enter' });
      expect(onDomainSave).toHaveBeenCalledOnce();
    });

    it('does not call onDomainSave when a non-Enter key is pressed', async () => {
      const onDomainSave = vi.fn();
      render(<TunnelSettings {...defaultProps} onDomainSave={onDomainSave} />);
      await expandSettings();
      fireEvent.keyDown(screen.getByLabelText('Custom domain'), { key: 'Tab' });
      expect(onDomainSave).not.toHaveBeenCalled();
    });

    it('calls onDomainChange when domain input value changes', async () => {
      const onDomainChange = vi.fn();
      render(<TunnelSettings {...defaultProps} onDomainChange={onDomainChange} />);
      await expandSettings();
      await userEvent.type(screen.getByLabelText('Custom domain'), 'a');
      expect(onDomainChange).toHaveBeenCalled();
    });
  });
});
