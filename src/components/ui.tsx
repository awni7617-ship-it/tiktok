import { cn } from '@/lib/cn';
import type { VideoStatus } from '@/lib/types';
import { WORKING_STATUSES } from '@/lib/types';
import { statusLabel } from '@/lib/format';

/** The small shared pieces. Kept in one file because there are few of them. */

export function Card({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('surface rounded-[--radius-card] border border-app p-5', className)}
      {...props}
    >
      {children}
    </div>
  );
}

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
};

export function Button({
  className,
  variant = 'ghost',
  size = 'md',
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'px-3 py-1.5 text-sm' : 'px-4 py-2 text-sm',
        variant === 'primary' && 'bg-brand-600 text-white hover:bg-brand-500',
        variant === 'ghost' && 'border border-app surface surface-hover',
        variant === 'danger' && 'border border-app text-rose-400 surface-hover',
        className,
      )}
      {...props}
    />
  );
}

export function StatusBadge({ status }: { status: VideoStatus }) {
  const working = WORKING_STATUSES.includes(status);
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium',
        status === 'published' && 'bg-mint-500/15 text-mint-400',
        status === 'ready' && 'bg-brand-500/15 text-brand-300',
        status === 'failed' && 'bg-rose-500/15 text-rose-400',
        status === 'queued' && 'bg-white/5 text-faint',
        working && 'bg-amber-400/15 text-amber-400',
      )}
    >
      {working && <span className="size-1.5 rounded-full bg-current animate-working" />}
      {statusLabel(status)}
    </span>
  );
}

export function Empty({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded-[--radius-panel] border border-dashed border-app px-6 py-16 text-center">
      <p className="font-medium">{title}</p>
      {children && <div className="mt-2 text-sm text-muted">{children}</div>}
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-medium">{label}</span>
      {hint && <span className="mt-0.5 block text-xs text-muted">{hint}</span>}
      <div className="mt-2">{children}</div>
    </label>
  );
}

export const inputClass =
  'w-full rounded-lg border border-app bg-transparent px-3 py-2 text-sm outline-none focus:border-brand-500';
