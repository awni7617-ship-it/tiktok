import { AppShell } from '@/components/shell';
import { SettingsKeys } from '@/components/settings/keys';

export const metadata = { title: 'Settings · Phantom' };

export default function SettingsPage() {
  return (
    <AppShell>
      <SettingsKeys />
    </AppShell>
  );
}
