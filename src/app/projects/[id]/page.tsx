import { notFound } from 'next/navigation';
import { AppShell } from '@/components/shell';
import { DEMO_PROJECTS, demoEditPlan, demoReport } from '@/server/demo/data';
import { EditorWorkspace } from '@/components/editor/workspace';

export const metadata = { title: 'Editor' };

/**
 * Project editor.
 *
 * The plan and report shown here are produced by the real engines on the
 * server, then handed to a client component for review. The split matters:
 * analysis is expensive and belongs on the server, while accepting or
 * rejecting a cut must feel instant, so the decision state is client-side and
 * only persisted when the user saves.
 */
export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = DEMO_PROJECTS.find((entry) => entry.id === id);
  if (!project) notFound();

  const { plan, summary } = await demoEditPlan(id);
  const report = await demoReport(id);

  return (
    <AppShell>
      <EditorWorkspace
        project={project}
        plan={plan}
        summary={summary}
        report={report}
      />
    </AppShell>
  );
}
