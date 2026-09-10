/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ManagedAuthenticationFieldsPage } from '@/lib/connectors/managed/authentication-owner-contract';

const navigation = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => navigation }));

import { ManagedAccountFieldsForm } from '../ManagedAccountFieldsForm';

const fieldsPage: ManagedAuthenticationFieldsPage = {
  kind: 'fields',
  descriptor: {
    toolkit: 'linear',
    scheme: 'API_KEY',
    kind: 'fields',
    source: 'account-fields',
    fields: [
      {
        name: 'api_key',
        label: 'Linear API key',
        description: 'Create this in Linear account settings.',
        type: 'password',
        required: true,
        secret: true,
      },
      {
        name: 'workspace',
        label: '<strong>Workspace</strong>',
        description: '<img src=x onerror=alert(1)>',
        type: 'string',
        required: false,
        secret: false,
      },
    ],
  },
  descriptorDigest: 'sha256:descriptor',
  csrfToken: 'csrf-opaque',
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('ManagedAccountFieldsForm', () => {
  it('renders declared labels as text, masks secrets, and separates service details from sign-in', () => {
    const { container } = render(<ManagedAccountFieldsForm page={fieldsPage} />);

    expect(screen.getByLabelText('Linear API key').getAttribute('type')).toBe('password');
    expect(screen.getByLabelText('<strong>Workspace</strong>').getAttribute('type')).toBe('text');
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText(/These are Linear account details/)).toBeTruthy();
    expect(screen.getByText(/separate from your DorkOS sign-in/)).toBeTruthy();
    expect(screen.queryByDisplayValue(/.+/)).toBeNull();
  });

  it.each([
    ['BEARER_TOKEN', 'Access token'],
    ['BASIC', 'Service password'],
  ] as const)('masks the declared %s secret field', (scheme, label) => {
    const page: ManagedAuthenticationFieldsPage = {
      ...fieldsPage,
      descriptor: {
        ...fieldsPage.descriptor,
        scheme,
        fields: [
          {
            name: 'secret',
            label,
            description: '',
            type: 'string',
            required: true,
            secret: true,
          },
        ],
      },
    };
    render(<ManagedAccountFieldsForm page={page} />);

    expect(screen.getByLabelText(label).getAttribute('type')).toBe('password');
  });

  it('clears fields before dispatch settles and sends only the frozen form contract', async () => {
    let settle: ((response: Response) => void) | undefined;
    const request = new Promise<Response>((resolve) => {
      settle = resolve;
    });
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => request);
    vi.stubGlobal('fetch', fetchMock);
    render(<ManagedAccountFieldsForm page={fieldsPage} />);

    const secret = screen.getByLabelText('Linear API key');
    fireEvent.change(secret, { target: { value: 'private-sentinel' } });
    fireEvent.change(screen.getByLabelText('<strong>Workspace</strong>'), {
      target: { value: 'roadmap' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Linear' }));

    expect((secret as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('<strong>Workspace</strong>') as HTMLInputElement).value).toBe(
      ''
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/connectors/managed/credentials',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        redirect: 'error',
      })
    );
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual({
      csrfToken: 'csrf-opaque',
      descriptorDigest: 'sha256:descriptor',
      fields: { api_key: 'private-sentinel', workspace: 'roadmap' },
    });

    settle?.(Response.json({ connectionId: 'connection-safe' }));
    await waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith(
        '/account/instances?connection=connection-safe'
      )
    );
  });

  it.each([
    ['closed server response', async () => new Response('private-sentinel', { status: 400 })],
    ['network exception', async () => Promise.reject(new Error('private-sentinel'))],
  ])('keeps %s details out of the rendered error', async (_name, response) => {
    vi.stubGlobal('fetch', vi.fn(response));
    render(<ManagedAccountFieldsForm page={fieldsPage} />);

    fireEvent.change(screen.getByLabelText('Linear API key'), {
      target: { value: 'private-sentinel' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Linear' }));

    expect((await screen.findByRole('alert')).textContent).not.toContain('private-sentinel');
    expect(screen.queryByDisplayValue('private-sentinel')).toBeNull();
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it('requires explicit owner confirmation for no-auth without inventing credential fields', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ connectionId: 'none-connected' })
    );
    vi.stubGlobal('fetch', fetchMock);
    const page: ManagedAuthenticationFieldsPage = {
      ...fieldsPage,
      kind: 'none',
      descriptor: {
        toolkit: 'public_data',
        scheme: 'NO_AUTH',
        kind: 'none',
        source: 'account-fields',
        fields: [],
      },
    };
    render(<ManagedAccountFieldsForm page={page} />);

    expect(screen.getByText('No account details are needed.')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Public Data' }));
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string).fields).toEqual({});
  });
});
