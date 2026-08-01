import { AppShell } from '@/components/shell';
import { StudioComposer } from '@/components/studio/composer';

export const metadata = { title: 'Make a video · Phantom' };

/**
 * The app opens on the thing it does.
 *
 * It used to open on a dashboard of demo numbers, which meant the first
 * screen a creator saw was data that was not theirs and did not update.
 */
export default function Home() {
  return (
    <AppShell>
      <StudioComposer />
    </AppShell>
  );
}
