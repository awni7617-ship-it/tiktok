import { AppShell } from '@/components/shell';
import { VideoLibrary } from '@/components/videos/library';

export const metadata = { title: 'Your videos · Phantom' };

export default function VideosPage() {
  return (
    <AppShell>
      <VideoLibrary />
    </AppShell>
  );
}
