import { AppShell } from '@/components/shell';
import { StudioComposer } from '@/components/studio/composer';

export const metadata = { title: 'AI Studio' };

export default function StudioPage() {
  return (
    <AppShell>
      <StudioComposer />
    </AppShell>
  );
}
