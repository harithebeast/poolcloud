'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDownAZ,
  ChevronRight,
  Info,
  LayoutGrid,
  List,
  Lock,
  MoreVertical,
  TriangleAlert,
  UploadCloud,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { describeError, get } from '@/lib/api';
import { cn } from '@/lib/cn';
import { collectDropped, ensureFolder, hasMoveItems, hasOsFiles, MOVE_MIME } from '@/lib/drop';
import { formatBytes, formatDate, isPreviewable } from '@/lib/format';
import { useEncryptPref, useViewPref } from '@/lib/prefs';
import type { Crumb, NodeDto } from '@/lib/types';
import { useFileActions } from '@/lib/use-file-actions';
import { DetailsPanel } from './details-panel';
import { FileIcon } from './file-icon';
import { ItemContextMenu, ItemDropdown, type MenuHandlers } from './item-menu';
import { MoveDialog } from './move-dialog';
import { PreviewDialog } from './preview-dialog';
import { PromptDialog } from './prompt-dialog';
import { ShareDialog } from './share-dialog';
import { useToast } from './toast';
import { Button } from './ui/button';
import { useUploads } from './upload-manager';

type SortKey = 'name' | 'modified' | 'size';

interface Props {
  /** Folder to show (null = root). Ignored when `searchQuery` is set. */
  folderId?: string | null;
  searchQuery?: string;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function FileBrowser({ folderId = null, searchQuery }: Props) {
  const searching = searchQuery !== undefined;
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const actions = useFileActions();
  const { enqueue } = useUploads();
  const [encrypt] = useEncryptPref();
  const [view, setView] = useViewPref();

  const [sort, setSort] = useState<SortKey>('name');
  const [selected, setSelected] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [renaming, setRenaming] = useState<NodeDto | null>(null);
  const [moving, setMoving] = useState<NodeDto[] | null>(null);
  const [sharing, setSharing] = useState<NodeDto | null>(null);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [osDrag, setOsDrag] = useState(false);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const list = useQuery({
    queryKey: searching ? ['files', 'search', searchQuery] : ['files', folderId],
    queryFn: () =>
      searching
        ? get<{ items: NodeDto[] }>('/files/search', { q: searchQuery })
        : get<{ items: NodeDto[] }>('/files', { parentId: folderId }),
  });
  const here = useQuery({
    queryKey: ['node', folderId],
    enabled: !searching && folderId !== null,
    queryFn: () => get<{ node: NodeDto; path: Crumb[] }>(`/files/${folderId}`),
  });

  useEffect(() => {
    setSelected([]);
    setAnchor(null);
  }, [folderId, searchQuery]);

  const items = useMemo(() => {
    const all = [...(list.data?.items ?? [])];
    const by: Record<SortKey, (a: NodeDto, b: NodeDto) => number> = {
      name: (a, b) => collator.compare(a.name, b.name),
      modified: (a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt),
      size: (a, b) => b.size - a.size,
    };
    return all.sort((a, b) => (a.type === b.type ? by[sort](a, b) : a.type === 'folder' ? -1 : 1));
  }, [list.data, sort]);

  const byId = useMemo(() => new Map(items.map((n) => [n.id, n])), [items]);
  const selectedNodes = selected.map((id) => byId.get(id)).filter((n): n is NodeDto => Boolean(n));
  const previewItems = useMemo(
    () => items.filter((n) => n.type === 'file' && isPreviewable(n.mime, n.type)),
    [items],
  );
  const location = searching
    ? 'Search results'
    : (here.data?.path.map((c) => c.name).join(' / ') ?? 'My files');

  // ── Selection ──────────────────────────────────────────────────────────────────────────────
  const select = useCallback(
    (e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }, n: NodeDto) => {
      if (e.shiftKey && anchor) {
        const a = items.findIndex((i) => i.id === anchor);
        const b = items.findIndex((i) => i.id === n.id);
        const [from, to] = a < b ? [a, b] : [b, a];
        setSelected(items.slice(from, to + 1).map((i) => i.id));
      } else if (e.ctrlKey || e.metaKey) {
        setSelected((s) => (s.includes(n.id) ? s.filter((x) => x !== n.id) : [...s, n.id]));
        setAnchor(n.id);
      } else {
        setSelected([n.id]);
        setAnchor(n.id);
      }
    },
    [anchor, items],
  );

  const open = useCallback(
    (n: NodeDto) => {
      if (n.type === 'folder') return router.push(`/files/${n.id}`);
      if (isPreviewable(n.mime, n.type) && !n.unavailable) {
        return setPreviewIndex(previewItems.findIndex((p) => p.id === n.id));
      }
      actions.download(n);
    },
    [actions, previewItems, router],
  );

  const handlers: MenuHandlers = {
    open,
    download: actions.download,
    share: setSharing,
    rename: setRenaming,
    move: setMoving,
    details: (n) => {
      setSelected([n.id]);
      setShowDetails(true);
    },
    trash: (ns) => {
      setSelected([]);
      void actions.trash(ns);
    },
    toggleEncrypt: (n) => void actions.setEncryptByDefault(n, !n.encryptByDefault),
  };

  /** What a menu or key press acts on: the whole selection if the item is in it, else just the item. */
  const targetsFor = (n: NodeDto) => (selected.includes(n.id) ? selectedNodes : [n]);

  function onKeyDown(e: KeyboardEvent<HTMLUListElement>) {
    if (
      (e.target as HTMLElement).closest('button, input, [role="menuitem"]') &&
      e.key !== 'Delete'
    ) {
      // Let buttons inside rows handle their own Enter/Space.
      if (e.key === 'Enter' || e.key === ' ') return;
    }
    const idx = items.findIndex(
      (i) => i.id === (document.activeElement as HTMLElement | null)?.dataset.id,
    );
    const focus = (i: number) => {
      const target = items[Math.max(0, Math.min(items.length - 1, i))];
      if (!target) return;
      listRef.current?.querySelector<HTMLElement>(`[data-id="${target.id}"]`)?.focus();
      if (!e.shiftKey) {
        setSelected([target.id]);
        setAnchor(target.id);
      } else select(e, target);
    };
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowRight':
        e.preventDefault();
        return focus(idx + 1);
      case 'ArrowUp':
      case 'ArrowLeft':
        e.preventDefault();
        return focus(idx - 1);
      case 'Home':
        e.preventDefault();
        return focus(0);
      case 'End':
        e.preventDefault();
        return focus(items.length - 1);
      case 'Enter': {
        const n = items[idx];
        if (n) open(n);
        return;
      }
      case ' ': {
        e.preventDefault();
        const n = items[idx];
        if (n) select({ shiftKey: false, ctrlKey: true, metaKey: false }, n);
        return;
      }
      case 'a':
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          setSelected(items.map((i) => i.id));
        }
        return;
      case 'F2':
        if (selectedNodes.length === 1) setRenaming(selectedNodes[0]!);
        return;
      case 'Delete':
        if (selectedNodes.length > 0) handlers.trash(selectedNodes);
        return;
      case 'Escape':
        setSelected([]);
    }
  }

  // ── Drag and drop ───────────────────────────────────────────────────────────────────────────
  async function uploadDropped(dt: DataTransfer) {
    const dropped = await collectDropped(dt);
    if (dropped.length === 0) return;
    const folderCache = new Map<string, string | null>([['', folderId]]);
    try {
      for (const { file, dirs } of dropped) {
        let parent: string | null = folderId;
        let key = '';
        for (const dir of dirs) {
          key += `/${dir}`;
          if (!folderCache.has(key)) folderCache.set(key, await ensureFolder(parent, dir));
          parent = folderCache.get(key) ?? null;
        }
        enqueue([file], parent, encrypt);
      }
      await qc.invalidateQueries({ queryKey: ['files'] });
    } catch (err) {
      toast(describeError(err), 'error');
    }
  }

  const onContainerDragOver = (e: DragEvent) => {
    if (searching || !hasOsFiles(e.dataTransfer)) return;
    e.preventDefault();
    setOsDrag(true);
  };
  const onContainerDrop = (e: DragEvent) => {
    if (searching || !hasOsFiles(e.dataTransfer)) return;
    e.preventDefault();
    setOsDrag(false);
    void uploadDropped(e.dataTransfer);
  };

  function moveDroppedOn(target: string | null, e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);
    const ids = JSON.parse(e.dataTransfer.getData(MOVE_MIME) || '[]') as string[];
    const nodes = ids
      .filter((id) => id !== target)
      .map((id) => byId.get(id))
      .filter((n): n is NodeDto => Boolean(n));
    if (nodes.length > 0) void actions.move(nodes, target);
  }
  const dropProps = (target: string | null) => ({
    onDragOver: (e: DragEvent) => {
      if (!hasMoveItems(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      setDropTarget(target ?? 'root');
    },
    onDragLeave: () => setDropTarget(null),
    onDrop: (e: DragEvent) => hasMoveItems(e.dataTransfer) && moveDroppedOn(target, e),
  });

  // ── Render ──────────────────────────────────────────────────────────────────────────────────
  const detailsNode = selectedNodes.length === 1 ? selectedNodes[0]! : null;
  const crumbs = here.data?.path ?? [];
  const unavailableCount = items.filter((i) => i.unavailable).length;

  return (
    <div className="flex h-full min-h-0">
      <div
        className="relative flex min-w-0 flex-1 flex-col"
        onDragOver={onContainerDragOver}
        onDragLeave={(e) => e.currentTarget === e.target && setOsDrag(false)}
        onDrop={onContainerDrop}
      >
        {/* Header: breadcrumbs and view controls */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2">
          <div className="relative min-w-0 flex-1 self-stretch">
            {searching ? (
              <h1 className="text-lg font-medium">Search results for “{searchQuery}”</h1>
            ) : (
              <nav aria-label="Breadcrumb">
                <ol className="flex flex-wrap items-center gap-1 text-lg">
                  <li>
                    <button
                      {...dropProps(null)}
                      onClick={() => router.push('/files')}
                      aria-current={folderId === null ? 'page' : undefined}
                      className={cn(
                        'rounded-lg px-2 py-1 hover:bg-surface-hover',
                        folderId === null && 'font-medium',
                        dropTarget === 'root' && 'bg-primary-soft',
                      )}
                    >
                      {folderId === null ? (
                        <h1 className="inline text-lg">My files</h1>
                      ) : (
                        'My files'
                      )}
                    </button>
                  </li>
                  {crumbs.map((c, i) => (
                    <li key={c.id} className="flex items-center gap-1">
                      <ChevronRight size={16} aria-hidden className="text-muted" />
                      <button
                        {...dropProps(c.id)}
                        onClick={() => router.push(`/files/${c.id}`)}
                        aria-current={i === crumbs.length - 1 ? 'page' : undefined}
                        className={cn(
                          'rounded-lg px-2 py-1 hover:bg-surface-hover',
                          i === crumbs.length - 1 && 'font-medium',
                          dropTarget === c.id && 'bg-primary-soft',
                        )}
                      >
                        {i === crumbs.length - 1 ? (
                          <h1 className="inline text-lg">{c.name}</h1>
                        ) : (
                          c.name
                        )}
                      </button>
                    </li>
                  ))}
                </ol>
              </nav>
            )}
            {/* Selection bar: replaces the header in place, so rows never shift under the pointer */}
            {selectedNodes.length > 0 && (
              <div
                className="absolute inset-0 z-10 flex items-center gap-2 rounded-lg bg-primary-soft px-3 text-sm text-on-primary-soft"
                role="toolbar"
                aria-label="Selection actions"
              >
                <span className="font-medium">{selectedNodes.length} selected</span>
                <span className="mx-2 h-4 w-px bg-current opacity-30" aria-hidden />
                <button
                  className="rounded-full px-3 py-1 hover:bg-black/10"
                  onClick={() => setMoving(selectedNodes)}
                >
                  Move
                </button>
                <button
                  className="rounded-full px-3 py-1 hover:bg-black/10"
                  onClick={() => handlers.trash(selectedNodes)}
                >
                  Move to trash
                </button>
                <button
                  className="ml-auto rounded-full px-3 py-1 hover:bg-black/10"
                  onClick={() => setSelected([])}
                >
                  Clear
                </button>
              </div>
            )}
          </div>
          <div className="flex items-center gap-1">
            <label className="flex items-center gap-1 text-sm text-muted">
              <ArrowDownAZ size={16} aria-hidden />
              <span className="sr-only">Sort by</span>
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as SortKey)}
                className="h-9 rounded-lg border border-line bg-bg px-2 text-sm text-fg"
              >
                <option value="name">Name</option>
                <option value="modified">Last modified</option>
                <option value="size">Size</option>
              </select>
            </label>
            <Button
              variant="ghost"
              size="icon"
              aria-label={view === 'grid' ? 'Switch to list view' : 'Switch to grid view'}
              onClick={() => setView(view === 'grid' ? 'list' : 'grid')}
            >
              {view === 'grid' ? (
                <List size={20} aria-hidden />
              ) : (
                <LayoutGrid size={20} aria-hidden />
              )}
            </Button>
            <Button
              variant={showDetails ? 'tonal' : 'ghost'}
              size="icon"
              aria-label="Toggle details"
              aria-pressed={showDetails}
              onClick={() => setShowDetails((s) => !s)}
            >
              <Info size={20} aria-hidden />
            </Button>
          </div>
        </div>

        {unavailableCount > 0 && (
          <p
            role="status"
            className="flex items-center gap-2 bg-warn-soft px-4 py-2 text-sm text-warn"
          >
            <TriangleAlert size={16} aria-hidden />
            {unavailableCount} {unavailableCount === 1 ? 'file is' : 'files are'} unavailable
            because a Google account is offline. Files split across accounts stop working while any
            account holding a piece is down.
          </p>
        )}

        {/* Content */}
        <div
          className="min-h-0 flex-1 overflow-auto p-4"
          onClick={(e) => e.target === e.currentTarget && setSelected([])}
        >
          {list.isPending ? (
            <p className="text-sm text-muted" role="status">
              Loading…
            </p>
          ) : list.isError ? (
            <div role="alert" className="space-y-3">
              <p className="text-sm text-danger">{describeError(list.error)}</p>
              <Button variant="outline" size="sm" onClick={() => void list.refetch()}>
                Try again
              </Button>
            </div>
          ) : items.length === 0 ? (
            <Empty searching={searching} />
          ) : (
            <>
              {view === 'list' && (
                <div
                  aria-hidden
                  className="mb-1 grid grid-cols-[1fr_7rem_6rem_2.5rem] gap-3 px-3 text-xs font-medium text-muted"
                >
                  <span>Name</span>
                  <span>Modified</span>
                  <span className="text-right">Size</span>
                  <span />
                </div>
              )}
              <ul
                ref={listRef}
                aria-label={searching ? 'Search results' : 'Files and folders'}
                onKeyDown={onKeyDown}
                className={cn(
                  view === 'grid'
                    ? 'grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-3'
                    : 'flex flex-col',
                )}
              >
                {items.map((n, i) => {
                  const isSelected = selected.includes(n.id);
                  const draggable = !searching;
                  return (
                    <li key={n.id} className="relative">
                      <ItemContextMenu targets={targetsFor(n)} handlers={handlers}>
                        <div
                          role="button"
                          aria-pressed={isSelected}
                          data-id={n.id}
                          tabIndex={isSelected || (selected.length === 0 && i === 0) ? 0 : -1}
                          draggable={draggable}
                          onClick={(e: MouseEvent) => select(e, n)}
                          onDoubleClick={() => open(n)}
                          onContextMenu={() =>
                            !isSelected &&
                            select({ shiftKey: false, ctrlKey: false, metaKey: false }, n)
                          }
                          onDragStart={(e) => {
                            const ids = isSelected ? selected : [n.id];
                            e.dataTransfer.setData(MOVE_MIME, JSON.stringify(ids));
                            e.dataTransfer.effectAllowed = 'move';
                            if (!isSelected) setSelected([n.id]);
                          }}
                          {...(n.type === 'folder' ? dropProps(n.id) : {})}
                          className={cn(
                            'group relative cursor-default select-none rounded-xl border text-sm',
                            view === 'grid'
                              ? 'flex flex-col gap-2 p-3'
                              : 'grid grid-cols-[1fr_7rem_6rem_2.5rem] items-center gap-3 rounded-lg px-3 py-2',
                            isSelected
                              ? 'border-transparent bg-primary-soft text-on-primary-soft'
                              : 'border-line hover:bg-surface-hover',
                            view === 'list' && !isSelected && 'border-transparent',
                            dropTarget === n.id && 'ring-2 ring-primary',
                            n.unavailable && 'opacity-70',
                          )}
                        >
                          <Row n={n} grid={view === 'grid'} selected={isSelected} />
                          {view === 'list' && (
                            <>
                              <span className={cn(!isSelected && 'text-muted')}>
                                {formatDate(n.updatedAt)}
                              </span>
                              <span className={cn('text-right', !isSelected && 'text-muted')}>
                                {n.type === 'file' ? formatBytes(n.size) : '—'}
                              </span>
                            </>
                          )}
                          {view === 'list' && <span aria-hidden />}
                        </div>
                      </ItemContextMenu>
                      <ItemDropdown
                        targets={targetsFor(n)}
                        handlers={handlers}
                        trigger={
                          <button
                            aria-label={`More actions for ${n.name}`}
                            className={cn(
                              'flex h-8 w-8 items-center justify-center rounded-full hover:bg-black/10',
                              'absolute right-2',
                              view === 'grid' ? 'top-2' : 'top-1/2 -translate-y-1/2',
                            )}
                            onClick={(e) => e.stopPropagation()}
                            onDoubleClick={(e) => e.stopPropagation()}
                          >
                            <MoreVertical size={16} aria-hidden />
                          </button>
                        }
                      />
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>

        {osDrag && (
          <div
            aria-hidden
            onDragLeave={() => setOsDrag(false)}
            onDrop={onContainerDrop}
            className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary bg-primary-soft/80"
          >
            <div className="flex flex-col items-center gap-2 text-on-primary-soft">
              <UploadCloud size={40} />
              <p className="text-lg font-medium">
                Drop files or folders to upload{encrypt ? ' (encrypted)' : ''}
              </p>
            </div>
          </div>
        )}
      </div>

      {showDetails && (
        <DetailsPanel
          node={detailsNode ?? (selected.length === 0 ? (here.data?.node ?? null) : null)}
          location={
            detailsNode
              ? location
              : crumbs
                  .slice(0, -1)
                  .map((c) => c.name)
                  .join(' / ') || 'My files'
          }
          count={selectedNodes.length}
          onClose={() => setShowDetails(false)}
        />
      )}

      <PreviewDialog
        items={previewItems}
        index={previewIndex !== null && previewIndex >= 0 ? previewIndex : null}
        onIndexChange={setPreviewIndex}
        onClose={() => setPreviewIndex(null)}
        onDownload={actions.download}
      />
      <ShareDialog node={sharing} onClose={() => setSharing(null)} />
      <MoveDialog
        items={moving}
        onClose={() => setMoving(null)}
        onMove={async (parent) => {
          if (moving && (await actions.move(moving, parent))) setSelected([]);
        }}
      />
      <PromptDialog
        open={renaming !== null}
        onOpenChange={(o) => !o && setRenaming(null)}
        title="Rename"
        label="Name"
        initial={renaming?.name}
        submitLabel="Rename"
        onSubmit={(name) => actions.rename(renaming!, name)}
      />
    </div>
  );
}

function Row({ n, grid, selected }: { n: NodeDto; grid: boolean; selected: boolean }) {
  const badges = (
    <>
      {n.encrypted && <Lock size={12} aria-label="Encrypted" className="shrink-0" />}
      {n.unavailable && (
        <TriangleAlert size={12} aria-label="Unavailable" className="shrink-0 text-warn" />
      )}
    </>
  );
  if (grid) {
    return (
      <>
        <div className="flex h-20 items-center justify-center rounded-lg bg-surface">
          <FileIcon mime={n.mime} type={n.type} size={40} />
        </div>
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate" title={n.name}>
            {n.name}
          </span>
          {badges}
        </div>
        <p className={cn('text-xs', !selected && 'text-muted')}>
          {n.type === 'file' ? `${formatBytes(n.size)} · ` : ''}
          {formatDate(n.updatedAt)}
        </p>
      </>
    );
  }
  return (
    <div className="flex min-w-0 items-center gap-3">
      <FileIcon mime={n.mime} type={n.type} />
      <span className="truncate" title={n.name}>
        {n.name}
      </span>
      {badges}
    </div>
  );
}

function Empty({ searching }: { searching: boolean }) {
  return (
    <div className="flex h-full min-h-64 flex-col items-center justify-center gap-2 text-center">
      <UploadCloud size={48} aria-hidden className="text-muted" />
      <p className="text-lg font-medium">
        {searching ? 'Nothing matches that search' : 'This folder is empty'}
      </p>
      {!searching && (
        <p className="text-sm text-muted">
          Drop files here, or use the New button to upload or create a folder.
        </p>
      )}
    </div>
  );
}
