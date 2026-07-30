import Link from 'next/link';
import { Sparkles, Upload } from 'lucide-react';
import { AppShell } from '@/components/shell';
import { Button, EmptyState } from '@/components/ui/primitives';
import { ProjectCard } from '@/components/project-card';
import { DEMO_PROJECTS } from '@/server/demo/data';

export const metadata = { title: 'Projects' };

export default function ProjectsPage() {
  return (
    <AppShell>
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
            <p className="mt-1 text-sm text-[var(--text-muted)]">
              {DEMO_PROJECTS.length} projects in this workspace
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" icon={<Upload className="size-4" />}>
              Upload
            </Button>
            <Link href="/studio">
              <Button variant="primary" icon={<Sparkles className="size-4" />}>
                Create with AI
              </Button>
            </Link>
          </div>
        </header>

        {DEMO_PROJECTS.length === 0 ? (
          <EmptyState
            icon={<Upload className="size-5" />}
            title="No projects yet"
            description="Upload a raw recording and the editor will cut, caption and reframe it, or start from a prompt in the AI Studio."
            action={<Button variant="primary">Upload your first video</Button>}
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {DEMO_PROJECTS.map((project) => (
              <ProjectCard key={project.id} project={project} />
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
