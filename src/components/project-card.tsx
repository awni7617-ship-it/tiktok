import Link from 'next/link';
import { Loader2, Play, Sparkles, Upload, Wand2 } from 'lucide-react';
import { Badge, Card } from '@/components/ui/primitives';
import { humanDuration } from '@/lib/time';
import type { DemoProject } from '@/server/demo/data';
import { cn } from '@/lib/cn';

const STATUS_TONE = {
  draft: 'neutral',
  analyzing: 'accent',
  ready: 'success',
  rendering: 'accent',
  published: 'neutral',
} as const;

const KIND_ICON = {
  upload: Upload,
  generated: Wand2,
  faceless: Sparkles,
} as const;

/**
 * Project tile.
 *
 * The thumbnail is a deterministic gradient derived from the project rather
 * than a grey box: before a render exists there is no real frame to show, and
 * a distinct colour makes projects scannable in a grid.
 */
export function ProjectCard({ project }: { project: DemoProject }) {
  const Icon = KIND_ICON[project.kind];
  const busy = project.status === 'analyzing' || project.status === 'rendering';

  return (
    <Link href={`/projects/${project.id}`} className="group block">
      <Card interactive className="h-full overflow-hidden p-0">
        <div
          className="relative aspect-video w-full"
          style={{
            background: `linear-gradient(135deg,
              oklch(0.45 0.16 ${project.thumbnailHue}),
              oklch(0.28 0.11 ${project.thumbnailHue + 40}))`,
          }}
        >
          <div className="absolute inset-0 grid place-items-center">
            {busy ? (
              <Loader2 className="size-7 animate-spin text-white/80" />
            ) : (
              <div className="grid size-11 place-items-center rounded-full bg-black/30 backdrop-blur-sm transition-transform duration-300 group-hover:scale-110">
                <Play className="size-4 translate-x-px fill-white text-white" />
              </div>
            )}
          </div>

          <span className="absolute bottom-2 right-2 rounded bg-black/60 px-1.5 py-0.5 font-mono text-[10px] text-white tabular-nums">
            {humanDuration(project.durationSec)}
          </span>

          <span className="absolute left-2 top-2 grid size-7 place-items-center rounded-lg bg-black/40 backdrop-blur-sm">
            <Icon className="size-3.5 text-white" />
          </span>
        </div>

        <div className="space-y-2.5 p-4">
          <h3 className="line-clamp-2 text-sm font-medium leading-snug">{project.title}</h3>

          <div className="flex items-center justify-between gap-2">
            <Badge tone={STATUS_TONE[project.status]}>
              {busy ? <Loader2 className="size-3 animate-spin" /> : null}
              {project.status}
            </Badge>

            {project.score !== null ? (
              <span
                className={cn(
                  'text-xs font-medium tabular-nums',
                  project.score >= 80
                    ? 'text-[var(--success)]'
                    : project.score >= 60
                      ? 'text-[var(--warning)]'
                      : 'text-[var(--danger)]',
                )}
                title="Readiness score from the optimizer"
              >
                {project.score}/100
              </span>
            ) : null}
          </div>

          <div className="flex items-center justify-between text-xs text-[var(--text-muted)]">
            <span>{project.updatedAt}</span>
            {project.platforms.length > 0 ? (
              <span className="truncate">{project.platforms.join(' · ')}</span>
            ) : null}
          </div>
        </div>
      </Card>
    </Link>
  );
}
