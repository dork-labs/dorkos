/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ReactNode } from 'react';
import { Dialog } from 'radix-ui';
import { UiProvider, usePortalContainer } from '../ui-provider.js';

const hosts: HTMLElement[] = [];

afterEach(() => {
  cleanup();
  for (const host of hosts) host.remove();
  hosts.length = 0;
});

function createHost(theme?: 'light' | 'dark'): HTMLElement {
  const host = document.createElement('div');
  host.dataset.portalHost = theme ?? 'plain';
  if (theme) host.className = theme;
  document.body.append(host);
  hosts.push(host);
  return host;
}

/** Exercise the same Radix Portal path that extracted overlay wrappers will use. */
function PortalProbe({
  name,
  container,
}: {
  name: string;
  container?: Element | DocumentFragment | null;
}) {
  const resolvedContainer = usePortalContainer(container);
  return (
    <Dialog.Root open>
      <Dialog.Portal container={resolvedContainer}>
        <div data-testid={name}>{name}</div>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Provider({
  container,
  children,
}: {
  container?: HTMLElement | null;
  children: ReactNode;
}) {
  return <UiProvider portalContainer={container}>{children}</UiProvider>;
}

describe('UiProvider portal ownership', () => {
  // Unconfigured consumers keep Radix's document-body portal behavior.
  it('uses document.body when no provider is mounted', async () => {
    const unused = createHost();
    render(<PortalProbe name="default" />);
    const portal = await screen.findByTestId('default');
    expect(document.body).toContainElement(portal);
    expect(unused).not.toContainElement(portal);
    expect(portal.parentElement).toBe(document.body);
  });

  // An explicit null provider resets an ancestor's destination to the body.
  it('keeps body behavior for an explicit null provider, including nested reset', async () => {
    const outer = createHost();
    render(
      <Provider container={outer}>
        <Provider container={null}>
          <PortalProbe name="null-provider" />
        </Provider>
      </Provider>
    );
    const portal = await screen.findByTestId('null-provider');
    expect(document.body).toContainElement(portal);
    expect(outer).not.toContainElement(portal);
    expect(portal.parentElement).toBe(document.body);
  });

  // Independent React subtrees may have different themed portal destinations.
  it('routes sibling providers to their own mounted light and dark hosts', async () => {
    const light = createHost('light');
    const dark = createHost('dark');
    const { container } = render(
      <>
        <Provider container={light}>
          <PortalProbe name="light-portal" />
        </Provider>
        <Provider container={dark}>
          <PortalProbe name="dark-portal" />
        </Provider>
      </>
    );
    const lightPortal = await screen.findByTestId('light-portal');
    const darkPortal = await screen.findByTestId('dark-portal');
    expect(light).toContainElement(lightPortal);
    expect(dark).toContainElement(darkPortal);
    expect(light).not.toContainElement(darkPortal);
    expect(dark).not.toContainElement(lightPortal);
    expect(lightPortal.closest('.light')).toBe(light);
    expect(darkPortal.closest('.dark')).toBe(dark);
    expect(container).toBeEmptyDOMElement();
  });

  // A nested provider overrides only its descendants and leaves the parent route intact.
  it('uses the nearest provider for nested portals', async () => {
    const outer = createHost();
    const inner = createHost();
    render(
      <Provider container={outer}>
        <PortalProbe name="outer-before" />
        <Provider container={inner}>
          <PortalProbe name="inner" />
        </Provider>
        <PortalProbe name="outer-after" />
      </Provider>
    );
    expect(outer).toContainElement(await screen.findByTestId('outer-before'));
    expect(inner).toContainElement(await screen.findByTestId('inner'));
    expect(outer).toContainElement(await screen.findByTestId('outer-after'));
    expect(outer).not.toContainElement(screen.getByTestId('inner'));
  });

  // Existing Radix Portal container props override the provider, including null.
  it('gives explicit Portal containers precedence over the provider', async () => {
    const provided = createHost();
    const explicit = createHost();
    render(
      <Provider container={provided}>
        <PortalProbe name="explicit-host" container={explicit} />
        <PortalProbe name="explicit-body" container={null} />
      </Provider>
    );
    expect(explicit).toContainElement(await screen.findByTestId('explicit-host'));
    const bodyPortal = await screen.findByTestId('explicit-body');
    expect(bodyPortal.parentElement).toBe(document.body);
    expect(provided).not.toContainElement(bodyPortal);
  });

  // The hook preserves Radix's DocumentFragment escape hatch for explicit callers.
  it('routes an explicit DocumentFragment without narrowing Radix Portal props', async () => {
    const provided = createHost();
    const fragment = document.createDocumentFragment();
    const { container } = render(
      <Provider container={provided}>
        <PortalProbe name="fragment" container={fragment} />
      </Provider>
    );
    const portal = container.ownerDocument.querySelector('[data-testid="fragment"]');
    expect(portal).toBeNull();
    expect(fragment.querySelector('[data-testid="fragment"]')).not.toBeNull();
    expect(provided.querySelector('[data-testid="fragment"]')).toBeNull();
  });
});
