'use client';
import { useQueryClient } from '@tanstack/react-query';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { Check, FolderPlus, Plus, Upload } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useRef, useState } from 'react';
import { post } from '@/lib/api';
import { useEncryptPref } from '@/lib/prefs';
import type { NodeDto } from '@/lib/types';
import { PromptDialog } from './prompt-dialog';
import { useToast } from './toast';
import { useUploads } from './upload-manager';

const item =
  'flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm outline-none data-[highlighted]:bg-surface-hover';

/** The "New" button: create a folder or upload into whichever folder is open. */
export function NewMenu() {
  const params = useParams<{ id?: string }>();
  const folderId = params.id ?? null;
  const qc = useQueryClient();
  const toast = useToast();
  const { enqueue } = useUploads();
  const [encrypt, setEncrypt] = useEncryptPref();
  const [creating, setCreating] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  return (
    <>
      <Menu.Root modal={false}>
        <Menu.Trigger className="flex h-12 items-center gap-2 rounded-2xl bg-primary-soft px-5 text-sm font-medium text-on-primary-soft shadow-sm hover:opacity-90">
          <Plus size={20} aria-hidden /> New
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content
            align="start"
            sideOffset={6}
            className="z-40 min-w-56 rounded-xl border border-line bg-bg p-1 shadow-lg"
          >
            <Menu.Item className={item} onSelect={() => setCreating(true)}>
              <FolderPlus size={18} aria-hidden /> New folder
            </Menu.Item>
            <Menu.Item className={item} onSelect={() => input.current?.click()}>
              <Upload size={18} aria-hidden /> Upload files
            </Menu.Item>
            <Menu.Separator className="my-1 h-px bg-line" />
            <Menu.CheckboxItem
              className={item}
              checked={encrypt}
              onCheckedChange={setEncrypt}
              onSelect={(e) => e.preventDefault()}
            >
              <span className="flex h-[18px] w-[18px] items-center justify-center">
                <Menu.ItemIndicator>
                  <Check size={16} aria-hidden />
                </Menu.ItemIndicator>
              </span>
              Encrypt new uploads
            </Menu.CheckboxItem>
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>

      <input
        ref={input}
        type="file"
        multiple
        className="hidden"
        aria-label="Choose files to upload"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          if (files.length > 0) enqueue(files, folderId, encrypt);
          e.target.value = '';
        }}
      />

      <PromptDialog
        open={creating}
        onOpenChange={setCreating}
        title="New folder"
        label="Folder name"
        initial="Untitled folder"
        submitLabel="Create"
        onSubmit={async (name) => {
          await post<NodeDto>('/folders', { name, parentId: folderId });
          await qc.invalidateQueries({ queryKey: ['files'] });
          toast('Folder created', 'success');
        }}
      />
    </>
  );
}
