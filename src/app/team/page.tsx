import { Role } from '@prisma/client';
import { MessageSquare, UserPlus } from 'lucide-react';
import { AppShell } from '@/components/shell';
import { Badge, Button, Card, SectionHeading } from '@/components/ui/primitives';
import { ROLE_DESCRIPTIONS, ROLE_ORDER, permissionsFor } from '@/server/auth/rbac';

export const metadata = { title: 'Team' };

const MEMBERS = [
  { name: 'Awni', email: 'awni@example.com', role: Role.OWNER, initial: 'A' },
  { name: 'Jordan Reid', email: 'jordan@example.com', role: Role.EDITOR, initial: 'J' },
  { name: 'Sam Okafor', email: 'sam@example.com', role: Role.REVIEWER, initial: 'S' },
  { name: 'Priya Raman', email: 'priya@example.com', role: Role.VIEWER, initial: 'P' },
];

const COMMENTS = [
  {
    author: 'Sam Okafor',
    at: '0:04',
    body: 'The hook still takes too long to land — can we cut straight to the claim?',
    time: '2 hours ago',
    resolved: false,
  },
  {
    author: 'Jordan Reid',
    at: '0:22',
    body: 'Caption covers her face here. Moved it up 8%.',
    time: 'Yesterday',
    resolved: true,
  },
];

/**
 * Team and permissions.
 *
 * The role table is generated from the RBAC module rather than written out in
 * markup, so what the UI promises and what the server enforces cannot drift.
 */
export default function TeamPage() {
  return (
    <AppShell>
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Team</h1>
            <p className="mt-1 text-sm text-[var(--text-muted)]">
              {MEMBERS.length} members in this workspace
            </p>
          </div>
          <Button variant="primary" icon={<UserPlus className="size-4" />}>
            Invite
          </Button>
        </header>

        <Card className="p-0">
          <ul className="divide-y divide-[var(--border-subtle)]">
            {MEMBERS.map((member) => (
              <li key={member.email} className="flex items-center gap-4 p-4">
                <div className="grid size-10 shrink-0 place-items-center rounded-full bg-[var(--accent)] text-sm font-semibold text-white">
                  {member.initial}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{member.name}</p>
                  <p className="truncate text-xs text-[var(--text-muted)]">{member.email}</p>
                </div>
                <Badge tone={member.role === Role.OWNER ? 'accent' : 'neutral'}>{member.role}</Badge>
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          <SectionHeading
            title="What each role can do"
            description="Enforced on the server, not just hidden in the interface."
          />
          <div className="scroll-x">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="text-left text-xs text-[var(--text-muted)]">
                  <th scope="col" className="pb-2 font-medium">Role</th>
                  <th scope="col" className="pb-2 font-medium">Summary</th>
                  <th scope="col" className="pb-2 text-right font-medium">Permissions</th>
                </tr>
              </thead>
              <tbody>
                {ROLE_ORDER.map((role) => (
                  <tr key={role} className="border-t border-[var(--border-subtle)] align-top">
                    <td className="py-3 font-medium">{role}</td>
                    <td className="py-3 pr-4 text-[var(--text-secondary)] text-pretty">
                      {ROLE_DESCRIPTIONS[role]}
                    </td>
                    <td className="py-3 text-right tabular-nums text-[var(--text-muted)]">
                      {permissionsFor(role).length}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card>
          <SectionHeading title="Recent comments" description="Anchored to a moment in the timeline." />
          <ul className="space-y-3">
            {COMMENTS.map((comment) => (
              <li
                key={comment.body}
                className="rounded-xl border border-[var(--border-subtle)] p-3.5"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <MessageSquare className="size-3.5 text-[var(--text-muted)]" />
                  <span className="text-sm font-medium">{comment.author}</span>
                  <span className="font-mono text-xs text-[var(--accent)]">{comment.at}</span>
                  <span className="text-xs text-[var(--text-muted)]">{comment.time}</span>
                  {comment.resolved ? <Badge tone="success">resolved</Badge> : null}
                </div>
                <p className="mt-2 text-sm text-[var(--text-secondary)] text-pretty">{comment.body}</p>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </AppShell>
  );
}
