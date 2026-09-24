import { useState, type FormEvent, type ReactNode } from 'react';
import {
  Button,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  Notice,
} from '@dork-labs/ui';

type Theme = 'system' | 'light' | 'dark';

export const CATALOG_SECTIONS = [
  { id: 'tokens', title: 'Tokens' },
  { id: 'buttons', title: 'Buttons' },
  { id: 'forms', title: 'Forms' },
  { id: 'notices', title: 'Notices' },
] as const;

const COLORS = [
  { name: 'Background', token: '--dui-background', className: 'bg-dui-background' },
  { name: 'Foreground', token: '--dui-foreground', className: 'bg-dui-foreground' },
  { name: 'Primary', token: '--dui-primary', className: 'bg-dui-primary' },
  { name: 'Secondary', token: '--dui-secondary', className: 'bg-dui-secondary' },
  { name: 'Muted', token: '--dui-muted', className: 'bg-dui-muted' },
  { name: 'Accent', token: '--dui-accent', className: 'bg-dui-accent' },
  { name: 'Destructive', token: '--dui-destructive', className: 'bg-dui-destructive' },
  { name: 'Brand', token: '--dui-brand', className: 'bg-dui-brand' },
  { name: 'Success', token: '--dui-success', className: 'bg-dui-success' },
] as const;

function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-heading`}
      className="border-dui-border scroll-mt-6 space-y-5 border-t pt-8"
    >
      <div className="space-y-1">
        <h2 id={`${id}-heading`} className="text-xl font-semibold tracking-tight">
          {title}
        </h2>
        <p className="text-dui-muted-foreground text-sm">{description}</p>
      </div>
      {children}
    </section>
  );
}

function Example({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-dui-border bg-dui-card space-y-3 rounded-lg border p-4 sm:p-5">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </div>
  );
}

/** Render only public UI package exports and portable fixtures. */
export function Catalog({ playgroundUrl }: { playgroundUrl: string }) {
  const [theme, setTheme] = useState<Theme>('system');
  const [submitted, setSubmitted] = useState(false);

  function submitExample(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
  }

  return (
    <main
      data-catalog-theme={theme}
      className={`${theme === 'system' ? '' : theme} bg-dui-background text-dui-foreground min-h-screen`}
    >
      <div className="mx-auto max-w-5xl space-y-10 px-4 py-8 sm:px-8 sm:py-12">
        <header className="flex flex-wrap items-start justify-between gap-6">
          <div className="max-w-2xl space-y-3">
            <p className="text-dui-muted-foreground text-xs font-semibold tracking-[0.16em] uppercase">
              DorkOS UI
            </p>
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
              Shared foundations
            </h1>
            <p className="text-dui-muted-foreground text-sm leading-6">
              The production tokens and controls used across DorkOS sign-in surfaces. Each example
              renders an export from @dork-labs/ui.
            </p>
          </div>
          <a
            className="focus-visible:outline-dui-ring text-sm font-medium underline underline-offset-4 focus-visible:rounded-sm focus-visible:outline-2"
            href={playgroundUrl}
          >
            Client playground
          </a>
        </header>

        <div className="border-dui-border bg-dui-card flex flex-wrap items-center justify-between gap-5 rounded-lg border p-4">
          <nav aria-label="Catalog sections" className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
            {CATALOG_SECTIONS.map((section) => (
              <a
                key={section.id}
                href={`#${section.id}`}
                className="focus-visible:outline-dui-ring underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-2"
              >
                {section.title}
              </a>
            ))}
          </nav>
          <fieldset className="flex min-w-0 flex-wrap items-center gap-2">
            <legend className="sr-only">Theme</legend>
            {(['system', 'light', 'dark'] as const).map((choice) => (
              <Button
                key={choice}
                type="button"
                size="sm"
                variant={theme === choice ? 'default' : 'outline'}
                aria-label={`${choice[0]!.toUpperCase()}${choice.slice(1)} theme`}
                aria-pressed={theme === choice}
                onClick={() => setTheme(choice)}
              >
                {choice[0]!.toUpperCase()}
                {choice.slice(1)}
              </Button>
            ))}
          </fieldset>
        </div>

        <Section
          id="tokens"
          title="Tokens"
          description="Namespaced colors stay distinct from each application's own palette."
        >
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {COLORS.map((color) => (
              <div
                key={color.name}
                className="border-dui-border bg-dui-card min-w-0 overflow-hidden rounded-lg border"
              >
                <div
                  aria-hidden="true"
                  className={`${color.className} border-dui-border h-16 border-b`}
                />
                <div className="p-3">
                  <p className="text-sm font-medium">{color.name}</p>
                  <code className="text-dui-muted-foreground text-xs break-all">{color.token}</code>
                </div>
              </div>
            ))}
          </div>
        </Section>

        <Section
          id="buttons"
          title="Buttons"
          description="The same component supplies action, size, focus and disabled behavior."
        >
          <Example title="Variants">
            <div className="flex flex-wrap items-center gap-3">
              <Button>Default</Button>
              <Button variant="secondary">Secondary</Button>
              <Button variant="destructive">Destructive</Button>
              <Button variant="outline">Outline</Button>
              <Button variant="ghost">Ghost</Button>
              <Button variant="brand">Brand</Button>
              <Button variant="link">Link</Button>
            </div>
          </Example>
          <Example title="Sizes and states">
            <div className="flex flex-wrap items-center gap-3">
              <Button size="xs">Extra small</Button>
              <Button size="sm">Small</Button>
              <Button size="md">Medium</Button>
              <Button size="lg">Large</Button>
              <Button size="icon-sm" aria-label="Icon size example">
                ✦
              </Button>
              <Button disabled>Disabled example</Button>
            </div>
          </Example>
          <Example title="Native form and slotted link">
            <form onSubmit={submitExample} className="flex flex-wrap items-center gap-3">
              <Button onClick={() => setSubmitted(false)}>Cancel example</Button>
              <Button type="submit">Submit example</Button>
              <Button asChild variant="outline">
                <a href="#forms">Slotted link example</a>
              </Button>
              {submitted && (
                <span role="status" className="text-dui-success text-sm">
                  Example submitted
                </span>
              )}
            </form>
          </Example>
        </Section>

        <Section
          id="forms"
          title="Forms"
          description="Labels and errors point to real controls and messages."
        >
          <div className="grid gap-4 md:grid-cols-2">
            <Example title="Label and description">
              <Field className="gap-2">
                <FieldLabel htmlFor="catalog-name">Name</FieldLabel>
                <Input id="catalog-name" name="name" autoComplete="name" placeholder="Your name" />
                <FieldDescription>Used only in this example.</FieldDescription>
              </Field>
            </Example>
            <Example title="Invalid and disabled">
              <div className="space-y-5">
                <Field className="gap-2" data-invalid>
                  <FieldLabel htmlFor="catalog-email">Email address</FieldLabel>
                  <Input
                    id="catalog-email"
                    type="email"
                    aria-invalid
                    aria-describedby="catalog-email-error"
                    defaultValue="invalid"
                  />
                  <FieldError id="catalog-email-error">Enter a valid email address.</FieldError>
                </Field>
                <Field className="gap-2" data-disabled>
                  <FieldLabel htmlFor="catalog-disabled">Unavailable field</FieldLabel>
                  <Input id="catalog-disabled" disabled placeholder="Disabled" />
                </Field>
              </div>
            </Example>
          </div>
          <Example title="Narrow screen and long label">
            <div className="border-dui-brand max-w-[390px] min-w-0 border-l-2 pl-4">
              <Field className="min-w-0 gap-2">
                <FieldLabel
                  htmlFor="catalog-long"
                  className="max-w-full break-words whitespace-normal"
                >
                  A longer field label that needs to remain readable when the catalog is narrow or
                  text is enlarged
                </FieldLabel>
                <Input id="catalog-long" placeholder="Still reachable at 390px" />
              </Field>
            </div>
          </Example>
        </Section>

        <Section
          id="notices"
          title="Notices"
          description="Errors announce by default; the other tones remain quiet unless a caller chooses otherwise."
        >
          <div className="grid gap-3 md:grid-cols-3">
            <Notice tone="info">A short piece of information.</Notice>
            <Notice tone="error">This example could not be saved.</Notice>
            <Notice tone="success">Saved changes.</Notice>
          </div>
        </Section>
      </div>
    </main>
  );
}
