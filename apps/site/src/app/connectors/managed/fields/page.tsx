import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/layers/shared/ui';
import { getTransactionDb } from '@/db/transaction-client';
import { getServerSession } from '@/lib/auth-session';
import {
  MANAGED_AUTHENTICATION_FIELDS_COOKIE,
  type ManagedAuthenticationFieldsPage,
} from '@/lib/connectors/managed/authentication-owner-contract';
import { createManagedAuthenticationOwnerService } from '@/lib/connectors/managed/authentication-owner-service';

import { ManagedAccountFieldsForm } from './ManagedAccountFieldsForm';

export const metadata: Metadata = {
  title: 'Connect a service',
  description: 'Finish connecting a service to DorkOS.',
  robots: { index: false, follow: false },
};
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function serviceName(toolkit: string): string {
  return toolkit
    .split(/[-_]/u)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

/** Render the owner-bound hosted form without exposing field metadata to a local installation. */
export default async function ManagedAuthenticationFieldsPageRoute() {
  const session = await getServerSession();
  if (!session) redirect('/signin?returnTo=%2Fconnectors%2Fmanaged%2Ffields');
  const cookieStore = await cookies();
  const cookieValue = cookieStore.get(MANAGED_AUTHENTICATION_FIELDS_COOKIE)?.value;
  if (!cookieValue) notFound();

  let page: ManagedAuthenticationFieldsPage | null = null;
  try {
    page = await createManagedAuthenticationOwnerService(getTransactionDb()).readFieldsPage({
      ownerId: session.user.id,
      cookieValue,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    notFound();
  }
  if (!page) notFound();
  const name = serviceName(page.descriptor.toolkit);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-lg items-center px-5 py-16 sm:px-8">
      <Card className="w-full">
        <CardHeader>
          <p className="text-muted-foreground text-sm">DorkOS managed connection</p>
          <CardTitle>Connect {name}</CardTitle>
          <CardDescription>
            Review this new {name} account connection before returning to DorkOS.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ManagedAccountFieldsForm page={page} />
        </CardContent>
      </Card>
    </main>
  );
}
