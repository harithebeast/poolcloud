'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { describeError } from '@/lib/api';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';
import { Field } from './ui/field';

/** A one-field dialog (new folder, rename). Keeps the dialog open and shows the error on failure. */
export function PromptDialog({
  open,
  onOpenChange,
  title,
  label,
  initial = '',
  submitLabel,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  label: string;
  initial?: string;
  submitLabel: string;
  onSubmit: (value: string) => Promise<unknown>;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setValue(initial);
      setError('');
      setBusy(false);
    }
  }, [open, initial]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!value.trim()) return setError('Enter a name.');
    setBusy(true);
    try {
      await onSubmit(value.trim());
      onOpenChange(false);
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title}>
      <form onSubmit={submit} className="space-y-4">
        <Field
          label={label}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          error={error || undefined}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
        />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {submitLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
