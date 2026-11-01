'use client';
import * as CM from '@radix-ui/react-context-menu';
import * as DM from '@radix-ui/react-dropdown-menu';
import { Download, FolderInput, Info, Lock, Pencil, Share2, Trash2, View } from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';
import { isPreviewable } from '@/lib/format';
import type { NodeDto } from '@/lib/types';

export interface MenuHandlers {
  open: (n: NodeDto) => void;
  download: (n: NodeDto) => void;
  share: (n: NodeDto) => void;
  rename: (n: NodeDto) => void;
  move: (n: NodeDto[]) => void;
  details: (n: NodeDto) => void;
  trash: (n: NodeDto[]) => void;
  toggleEncrypt: (n: NodeDto) => void;
}

interface Prims {
  Item: ComponentType<{
    className?: string;
    onSelect?: () => void;
    children?: ReactNode;
    disabled?: boolean;
  }>;
  Separator: ComponentType<{ className?: string }>;
}

const ITEM =
  'flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm outline-none data-[highlighted]:bg-surface-hover data-[disabled]:opacity-50';
const DANGER = `${ITEM} text-danger`;
const SEP = 'my-1 h-px bg-line';
const CONTENT = 'z-40 min-w-56 rounded-xl border border-line bg-bg p-1 shadow-lg';

function Items({ P, targets, h }: { P: Prims; targets: NodeDto[]; h: MenuHandlers }) {
  const one = targets.length === 1 ? targets[0]! : null;
  const canOpen =
    one && (one.type === 'folder' || (isPreviewable(one.mime, one.type) && !one.unavailable));
  return (
    <>
      {one && canOpen && (
        <P.Item className={ITEM} onSelect={() => h.open(one)}>
          <View size={16} aria-hidden /> {one.type === 'folder' ? 'Open' : 'Preview'}
        </P.Item>
      )}
      {one?.type === 'file' && (
        <>
          <P.Item className={ITEM} onSelect={() => h.download(one)}>
            <Download size={16} aria-hidden /> Download
          </P.Item>
          <P.Item className={ITEM} onSelect={() => h.share(one)}>
            <Share2 size={16} aria-hidden /> Share
          </P.Item>
        </>
      )}
      {one && (
        <P.Item className={ITEM} onSelect={() => h.rename(one)}>
          <Pencil size={16} aria-hidden /> Rename
        </P.Item>
      )}
      <P.Item className={ITEM} onSelect={() => h.move(targets)}>
        <FolderInput size={16} aria-hidden /> Move to…
      </P.Item>
      {one?.type === 'folder' && (
        <P.Item className={ITEM} onSelect={() => h.toggleEncrypt(one)}>
          <Lock size={16} aria-hidden />
          {one.encryptByDefault ? 'Stop encrypting new files' : 'Encrypt new files in this folder'}
        </P.Item>
      )}
      {one && (
        <P.Item className={ITEM} onSelect={() => h.details(one)}>
          <Info size={16} aria-hidden /> Details
        </P.Item>
      )}
      <P.Separator className={SEP} />
      <P.Item className={DANGER} onSelect={() => h.trash(targets)}>
        <Trash2 size={16} aria-hidden /> Move to trash
      </P.Item>
    </>
  );
}

const CONTEXT: Prims = { Item: CM.Item, Separator: CM.Separator };
const DROPDOWN: Prims = { Item: DM.Item, Separator: DM.Separator };

/** Right-click menu around an item. */
export function ItemContextMenu({
  children,
  targets,
  handlers,
}: {
  children: ReactNode;
  targets: NodeDto[];
  handlers: MenuHandlers;
}) {
  return (
    <CM.Root modal={false}>
      <CM.Trigger asChild>{children}</CM.Trigger>
      <CM.Portal>
        <CM.Content className={CONTENT}>
          <Items P={CONTEXT} targets={targets} h={handlers} />
        </CM.Content>
      </CM.Portal>
    </CM.Root>
  );
}

/** The same actions behind a "⋮" button, for keyboard and touch users. */
export function ItemDropdown({
  trigger,
  targets,
  handlers,
}: {
  trigger: ReactNode;
  targets: NodeDto[];
  handlers: MenuHandlers;
}) {
  return (
    <DM.Root modal={false}>
      <DM.Trigger asChild>{trigger}</DM.Trigger>
      <DM.Portal>
        <DM.Content align="end" sideOffset={4} className={CONTENT}>
          <Items P={DROPDOWN} targets={targets} h={handlers} />
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}
