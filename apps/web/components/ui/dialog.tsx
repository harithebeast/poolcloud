'use client';
import * as D from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  wide,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <D.Content
          className={cn(
            'fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-2xl border border-line bg-bg p-6 shadow-xl',
            wide ? 'max-w-4xl' : 'max-w-md',
          )}
        >
          <div className="mb-4 flex items-start justify-between gap-4">
            <div className="min-w-0">
              <D.Title className="truncate text-lg font-semibold">{title}</D.Title>
              <D.Description className={description ? 'mt-1 text-sm text-muted' : 'sr-only'}>
                {description ?? title}
              </D.Description>
            </div>
            <D.Close
              aria-label="Close"
              className="rounded-full p-2 text-muted hover:bg-surface-hover"
            >
              <X size={18} aria-hidden />
            </D.Close>
          </div>
          {children}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
