'use client';
import { useParams } from 'next/navigation';
import { FileBrowser } from '@/components/file-browser';

export default function Folder() {
  const { id } = useParams<{ id: string }>();
  return <FileBrowser folderId={id} />;
}
