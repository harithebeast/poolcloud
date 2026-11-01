'use client';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { FileBrowser } from '@/components/file-browser';

function Results() {
  const q = useSearchParams().get('q') ?? '';
  return <FileBrowser searchQuery={q} />;
}

export default function Search() {
  return (
    <Suspense fallback={<p className="p-4 text-sm text-muted">Loading…</p>}>
      <Results />
    </Suspense>
  );
}
