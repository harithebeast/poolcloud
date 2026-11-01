import {
  Archive,
  File,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  Folder,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { kindOf, type Kind } from '@/lib/format';

const ICONS: Record<Kind, { icon: LucideIcon; color: string }> = {
  folder: { icon: Folder, color: 'text-muted' },
  image: { icon: FileImage, color: 'text-danger' },
  pdf: { icon: FileText, color: 'text-danger' },
  text: { icon: FileText, color: 'text-primary' },
  video: { icon: FileVideo, color: 'text-warn' },
  audio: { icon: FileAudio, color: 'text-warn' },
  archive: { icon: Archive, color: 'text-muted' },
  file: { icon: File, color: 'text-muted' },
};

export function FileIcon({
  mime,
  type,
  size = 20,
  className,
}: {
  mime: string | null;
  type: 'file' | 'folder';
  size?: number;
  className?: string;
}) {
  const { icon: Icon, color } = ICONS[kindOf(mime, type)];
  return <Icon size={size} aria-hidden className={cn(color, 'shrink-0', className)} />;
}
