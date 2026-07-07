'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

import { Button, Input } from '@/layers/shared/ui';

/**
 * Email/name search for the admin users table. URL-driven: submitting navigates
 * to `/admin?search=…` so the server component re-fetches the filtered page (and
 * the query is shareable/back-button friendly).
 *
 * @param props.initial - The current search term (from the URL) to seed the input.
 */
export function AdminSearch({ initial }: { initial: string }) {
  const router = useRouter();
  const [value, setValue] = useState(initial);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const q = value.trim();
    router.push(q ? `/admin?search=${encodeURIComponent(q)}` : '/admin');
  }

  return (
    <form onSubmit={submit} className="flex w-full max-w-md items-center gap-2">
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Search by email…"
        aria-label="Search users by email"
      />
      <Button type="submit" variant="outline">
        Search
      </Button>
      {initial ? (
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setValue('');
            router.push('/admin');
          }}
        >
          Clear
        </Button>
      ) : null}
    </form>
  );
}
