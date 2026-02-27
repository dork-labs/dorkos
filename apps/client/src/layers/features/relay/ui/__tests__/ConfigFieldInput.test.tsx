/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { ConfigField } from '@dorkos/shared/relay-schemas';
import { ConfigFieldInput, ConfigFieldGroup } from '../ConfigFieldInput';

// ---------------------------------------------------------------------------
// Field fixtures
// ---------------------------------------------------------------------------

const textField: ConfigField = {
  key: 'name',
  label: 'Name',
  type: 'text',
  required: false,
};

const urlField: ConfigField = {
  key: 'endpoint',
  label: 'Endpoint',
  type: 'url',
  required: false,
  placeholder: 'https://example.com',
};

const passwordField: ConfigField = {
  key: 'token',
  label: 'API Token',
  type: 'password',
  required: true,
};

const numberField: ConfigField = {
  key: 'timeout',
  label: 'Timeout',
  type: 'number',
  required: false,
  placeholder: '30',
};

const booleanField: ConfigField = {
  key: 'enabled',
  label: 'Enabled',
  type: 'boolean',
  required: false,
};

const selectField: ConfigField = {
  key: 'mode',
  label: 'Mode',
  type: 'select',
  required: false,
  options: [
    { label: 'Polling', value: 'polling' },
    { label: 'Webhook', value: 'webhook' },
  ],
};

const textareaField: ConfigField = {
  key: 'notes',
  label: 'Notes',
  type: 'textarea',
  required: false,
  description: 'Additional context',
};

const conditionalField: ConfigField = {
  key: 'webhookUrl',
  label: 'Webhook URL',
  type: 'url',
  required: false,
  showWhen: { field: 'mode', equals: 'webhook' },
};

const requiredField: ConfigField = {
  key: 'apiKey',
  label: 'API Key',
  type: 'text',
  required: true,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderField(
  field: ConfigField,
  overrides: {
    value?: unknown;
    onChange?: (key: string, value: unknown) => void;
    error?: string;
    allValues?: Record<string, unknown>;
  } = {},
) {
  const onChange = overrides.onChange ?? vi.fn();
  return render(
    <ConfigFieldInput
      field={field}
      value={overrides.value ?? ''}
      onChange={onChange}
      error={overrides.error}
      allValues={overrides.allValues ?? {}}
    />,
  );
}

// ---------------------------------------------------------------------------
// ConfigFieldInput tests
// ---------------------------------------------------------------------------

describe('ConfigFieldInput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  // --- field type rendering --------------------------------------------------

  it('renders a text input for type "text"', () => {
    renderField(textField);
    const input = screen.getByRole('textbox');
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute('type', 'text');
  });

  it('renders a url input for type "url"', () => {
    renderField(urlField);
    // url inputs don't have implicit role; query by placeholder
    const input = screen.getByPlaceholderText('https://example.com');
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute('type', 'url');
  });

  it('renders a password input for type "password"', () => {
    renderField(passwordField);
    const input = screen.getByLabelText('API Token');
    expect(input).toHaveAttribute('type', 'password');
  });

  it('toggles password visibility when eye button is clicked', () => {
    renderField(passwordField);
    const input = screen.getByLabelText('API Token');
    expect(input).toHaveAttribute('type', 'password');

    fireEvent.click(screen.getByRole('button', { name: /show password/i }));
    expect(input).toHaveAttribute('type', 'text');

    fireEvent.click(screen.getByRole('button', { name: /hide password/i }));
    expect(input).toHaveAttribute('type', 'password');
  });

  it('renders a number input for type "number"', () => {
    renderField(numberField, { value: 30 });
    const input = screen.getByRole('spinbutton');
    expect(input).toHaveAttribute('type', 'number');
  });

  it('renders a switch for type "boolean"', () => {
    renderField(booleanField, { value: false });
    expect(screen.getByRole('switch')).toBeInTheDocument();
  });

  it('renders a select trigger for type "select"', () => {
    renderField(selectField, { value: 'polling' });
    expect(screen.getByRole('combobox')).toBeInTheDocument();
  });

  it('renders a textarea for type "textarea"', () => {
    renderField(textareaField);
    expect(screen.getByRole('textbox')).toBeInTheDocument();
    // Textarea renders as a <textarea> element
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(ta.tagName.toLowerCase()).toBe('textarea');
  });

  // --- description and error display -----------------------------------------

  it('shows description text below the input', () => {
    renderField(textareaField);
    expect(screen.getByText('Additional context')).toBeInTheDocument();
  });

  it('shows error message when error prop is provided', () => {
    renderField(textField, { error: 'This field is required' });
    const errorEl = screen.getByText('This field is required');
    expect(errorEl).toBeInTheDocument();
    expect(errorEl).toHaveClass('text-red-500');
  });

  it('does not show an error message when error prop is absent', () => {
    renderField(textField);
    expect(screen.queryByText('text-red-500')).toBeNull();
  });

  // --- required asterisk -----------------------------------------------------

  it('applies required asterisk class when field.required is true', () => {
    renderField(requiredField);
    const label = screen.getByText('API Key');
    expect(label.className).toMatch(/after:/);
  });

  it('does not apply required asterisk class when field.required is false', () => {
    renderField(textField);
    const label = screen.getByText('Name');
    expect(label.className).not.toMatch(/after:text-red-500/);
  });

  // --- showWhen conditional visibility ----------------------------------------

  it('returns null when showWhen condition is not met', () => {
    const { container } = render(
      <ConfigFieldInput
        field={conditionalField}
        value=""
        onChange={vi.fn()}
        allValues={{ mode: 'polling' }}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders normally when showWhen condition is met', () => {
    render(
      <ConfigFieldInput
        field={conditionalField}
        value=""
        onChange={vi.fn()}
        allValues={{ mode: 'webhook' }}
      />,
    );
    expect(screen.getByText('Webhook URL')).toBeInTheDocument();
  });

  // --- onChange callbacks -----------------------------------------------------

  it('calls onChange with the correct key and value when user types in a text field', () => {
    const onChange = vi.fn();
    renderField(textField, { onChange, value: '' });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hello' } });
    expect(onChange).toHaveBeenCalledWith('name', 'hello');
  });

  it('calls onChange with a number when user types in a number field', () => {
    const onChange = vi.fn();
    renderField(numberField, { onChange, value: '' });
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '42' } });
    expect(onChange).toHaveBeenCalledWith('timeout', 42);
  });

  it('calls onChange with a boolean when switch is toggled', () => {
    const onChange = vi.fn();
    renderField(booleanField, { onChange, value: false });
    fireEvent.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenCalledWith('enabled', true);
  });
});

// ---------------------------------------------------------------------------
// ConfigFieldGroup tests
// ---------------------------------------------------------------------------

describe('ConfigFieldGroup', () => {
  afterEach(() => {
    cleanup();
  });

  const ungroupedFields: ConfigField[] = [
    { key: 'name', label: 'Name', type: 'text', required: false },
    { key: 'token', label: 'Token', type: 'password', required: true },
  ];

  const sectionedFields: ConfigField[] = [
    { key: 'host', label: 'Host', type: 'text', required: false, section: 'Connection' },
    { key: 'port', label: 'Port', type: 'number', required: false, section: 'Connection' },
    { key: 'retries', label: 'Retries', type: 'number', required: false, section: 'Advanced' },
  ];

  it('renders all ungrouped fields without section headings', () => {
    render(
      <ConfigFieldGroup
        fields={ungroupedFields}
        values={{}}
        onChange={vi.fn()}
        errors={{}}
      />,
    );
    expect(screen.getByText('Name')).toBeInTheDocument();
    expect(screen.getByText('Token')).toBeInTheDocument();
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('renders section headings for fields with a section property', () => {
    render(
      <ConfigFieldGroup
        fields={sectionedFields}
        values={{}}
        onChange={vi.fn()}
        errors={{}}
      />,
    );
    expect(screen.getByText('Connection')).toBeInTheDocument();
    expect(screen.getByText('Advanced')).toBeInTheDocument();
  });

  it('renders all fields within their respective sections', () => {
    render(
      <ConfigFieldGroup
        fields={sectionedFields}
        values={{}}
        onChange={vi.fn()}
        errors={{}}
      />,
    );
    expect(screen.getByText('Host')).toBeInTheDocument();
    expect(screen.getByText('Port')).toBeInTheDocument();
    expect(screen.getByText('Retries')).toBeInTheDocument();
  });

  it('passes error messages down to each field', () => {
    render(
      <ConfigFieldGroup
        fields={ungroupedFields}
        values={{}}
        onChange={vi.fn()}
        errors={{ name: 'Name is required' }}
      />,
    );
    expect(screen.getByText('Name is required')).toBeInTheDocument();
  });
});
