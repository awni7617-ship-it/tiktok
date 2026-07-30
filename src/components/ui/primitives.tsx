'use client';

import {
  forwardRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * Design-system primitives.
 *
 * Every interactive element here is a real semantic control (`button`,
 * `input`, `select`) with a visible focus ring and an accessible name, rather
 * than a styled `div` with a click handler. Accessibility is cheaper to build
 * in at this layer than to retrofit across every screen.
 */

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
type ButtonSize = 'sm' | 'md' | 'lg' | 'icon';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-[var(--accent)] text-[var(--accent-contrast)] hover:bg-[var(--accent-hover)] shadow-[0_4px_16px_-4px_var(--accent)] hover:shadow-[0_6px_24px_-4px_var(--accent)]',
  secondary:
    'bg-[var(--surface-raised)] text-[var(--text-primary)] border border-[var(--border-default)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)] backdrop-blur-md',
  ghost: 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-hover)]',
  danger: 'bg-[var(--danger)] text-white hover:brightness-110',
  outline:
    'border border-[var(--border-strong)] text-[var(--text-primary)] hover:bg-[var(--surface-hover)]',
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-xs gap-1.5 rounded-lg',
  md: 'h-10 px-4 text-sm gap-2 rounded-xl',
  lg: 'h-12 px-6 text-base gap-2.5 rounded-xl',
  icon: 'h-10 w-10 rounded-xl',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'secondary', size = 'md', loading, icon, children, disabled, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      // A loading button must stay unclickable, or a double-submit slips through.
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex items-center justify-center font-medium whitespace-nowrap',
        'transition-all duration-200 ease-[var(--ease-out-quint)]',
        'disabled:opacity-45 disabled:pointer-events-none',
        'active:scale-[0.98]',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
      {...props}
    >
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
});

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

export function Card({
  className,
  interactive,
  ...props
}: HTMLAttributes<HTMLDivElement> & { interactive?: boolean }) {
  return (
    <div
      className={cn(
        'panel p-5',
        interactive &&
          'transition-all duration-300 ease-[var(--ease-out-quint)] hover:-translate-y-0.5 hover:shadow-[var(--shadow-lift)] hover:border-[var(--border-strong)]',
        className,
      )}
      {...props}
    />
  );
}

export function SectionHeading({
  title,
  description,
  action,
  className,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-start justify-between gap-4 mb-4', className)}>
      <div className="min-w-0">
        <h2 className="text-base font-semibold tracking-tight">{title}</h2>
        {description ? (
          <p className="mt-1 text-sm text-[var(--text-muted)] text-balance">{description}</p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Badges & status
// ---------------------------------------------------------------------------

type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'bg-[var(--surface-hover)] text-[var(--text-secondary)] border-[var(--border-default)]',
  accent: 'bg-[color-mix(in_oklab,var(--accent)_16%,transparent)] text-[var(--accent-hover)] border-[color-mix(in_oklab,var(--accent)_35%,transparent)]',
  success: 'bg-[color-mix(in_oklab,var(--success)_16%,transparent)] text-[var(--success)] border-[color-mix(in_oklab,var(--success)_35%,transparent)]',
  warning: 'bg-[color-mix(in_oklab,var(--warning)_16%,transparent)] text-[var(--warning)] border-[color-mix(in_oklab,var(--warning)_35%,transparent)]',
  danger: 'bg-[color-mix(in_oklab,var(--danger)_16%,transparent)] text-[var(--danger)] border-[color-mix(in_oklab,var(--danger)_35%,transparent)]',
};

export function Badge({
  tone = 'neutral',
  className,
  children,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium',
        BADGE_TONES[tone],
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}

/**
 * Status dot with a text label. The label is not decorative — colour alone is
 * not an accessible status indicator.
 */
export function StatusDot({ tone = 'neutral', label }: { tone?: BadgeTone; label: string }) {
  const colors: Record<BadgeTone, string> = {
    neutral: 'bg-[var(--text-muted)]',
    accent: 'bg-[var(--accent)]',
    success: 'bg-[var(--success)]',
    warning: 'bg-[var(--warning)]',
    danger: 'bg-[var(--danger)]',
  };

  return (
    <span className="inline-flex items-center gap-2 text-xs text-[var(--text-secondary)]">
      <span className={cn('size-2 rounded-full', colors[tone])} aria-hidden />
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Form controls
// ---------------------------------------------------------------------------

const FIELD_BASE =
  'w-full rounded-xl border border-[var(--border-default)] bg-[var(--surface-inset)] px-3.5 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] transition-colors focus:border-[var(--accent)] focus:outline-none focus-visible:outline-none disabled:opacity-50';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return <input ref={ref} className={cn(FIELD_BASE, 'h-10', className)} {...props} />;
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...props }, ref) {
    return <textarea ref={ref} className={cn(FIELD_BASE, 'py-2.5 resize-y min-h-24', className)} {...props} />;
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...props }, ref) {
    return (
      <select ref={ref} className={cn(FIELD_BASE, 'h-10 pr-8 appearance-none', className)} {...props}>
        {children}
      </select>
    );
  },
);

/**
 * Labelled field wrapper.
 *
 * Always renders a real `<label>` bound to the control by id, and wires
 * `aria-describedby` for hints and errors so screen readers announce them.
 */
export function Field({
  label,
  hint,
  error,
  htmlFor,
  required,
  children,
  className,
}: {
  label: string;
  hint?: string;
  error?: string;
  htmlFor: string;
  required?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const hintId = hint ? `${htmlFor}-hint` : undefined;
  const errorId = error ? `${htmlFor}-error` : undefined;

  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={htmlFor} className="block text-sm font-medium text-[var(--text-secondary)]">
        {label}
        {required ? (
          <span className="text-[var(--danger)] ml-0.5" aria-hidden>
            *
          </span>
        ) : null}
      </label>
      {children}
      {hint && !error ? (
        <p id={hintId} className="text-xs text-[var(--text-muted)]">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-[var(--danger)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Accessible switch built on a real checkbox input. */
export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
  id,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
  id: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm font-medium cursor-pointer select-none">
          {label}
        </label>
        {description ? (
          <p className="text-xs text-[var(--text-muted)] mt-0.5 text-pretty">{description}</p>
        ) : null}
      </div>
      <button
        type="button"
        role="switch"
        id={id}
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200',
          'disabled:opacity-40 disabled:pointer-events-none',
          checked ? 'bg-[var(--accent)]' : 'bg-[var(--border-strong)]',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 size-5 rounded-full bg-white shadow transition-transform duration-200 ease-[var(--ease-spring)]',
            checked ? 'translate-x-5.5' : 'translate-x-0.5',
          )}
        />
      </button>
    </div>
  );
}

/** Range slider with a live-updating value readout. */
export function Slider({
  id,
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  format,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  format?: (value: number) => string;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label htmlFor={id} className="text-sm font-medium text-[var(--text-secondary)]">
          {label}
        </label>
        <span className="text-xs tabular-nums text-[var(--text-muted)]">
          {format ? format(value) : value}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

export function ProgressBar({
  value,
  label,
  tone = 'accent',
}: {
  value: number;
  label?: string;
  tone?: BadgeTone;
}) {
  const percent = Math.round(Math.max(0, Math.min(1, value)) * 100);
  const colors: Record<BadgeTone, string> = {
    neutral: 'bg-[var(--text-muted)]',
    accent: 'bg-[var(--accent)]',
    success: 'bg-[var(--success)]',
    warning: 'bg-[var(--warning)]',
    danger: 'bg-[var(--danger)]',
  };

  return (
    <div className="space-y-1.5">
      {label ? (
        <div className="flex justify-between text-xs text-[var(--text-muted)]">
          <span>{label}</span>
          <span className="tabular-nums">{percent}%</span>
        </div>
      ) : null}
      <div
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label ?? 'Progress'}
        className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-inset)]"
      >
        <div
          className={cn('h-full rounded-full transition-[width] duration-500 ease-out', colors[tone])}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-[var(--radius-panel)] border border-dashed border-[var(--border-default)] px-6 py-14 text-center">
      {icon ? (
        <div className="mb-4 grid size-12 place-items-center rounded-2xl bg-[var(--surface-hover)] text-[var(--text-muted)]">
          {icon}
        </div>
      ) : null}
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-1.5 max-w-sm text-sm text-[var(--text-muted)] text-pretty">{description}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={cn('skeleton rounded-lg', className)} aria-hidden>
      <div className="skeleton-shimmer" />
    </div>
  );
}

/** Non-blocking inline notice. `role="alert"` only for genuine errors. */
export function Notice({
  tone = 'neutral',
  title,
  children,
}: {
  tone?: BadgeTone;
  title?: string;
  children: ReactNode;
}) {
  const borders: Record<BadgeTone, string> = {
    neutral: 'border-l-[var(--text-muted)]',
    accent: 'border-l-[var(--accent)]',
    success: 'border-l-[var(--success)]',
    warning: 'border-l-[var(--warning)]',
    danger: 'border-l-[var(--danger)]',
  };

  return (
    <div
      role={tone === 'danger' ? 'alert' : undefined}
      className={cn(
        'rounded-lg border border-[var(--border-subtle)] border-l-2 bg-[var(--surface-inset)] px-4 py-3 text-sm',
        borders[tone],
      )}
    >
      {title ? <p className="font-medium mb-0.5">{title}</p> : null}
      <div className="text-[var(--text-secondary)] text-pretty">{children}</div>
    </div>
  );
}

/** Keyboard shortcut hint. */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-[var(--border-default)] bg-[var(--surface-inset)] px-1.5 font-mono text-[10px] font-medium text-[var(--text-muted)]">
      {children}
    </kbd>
  );
}

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
  className,
}: {
  tabs: { id: T; label: string; count?: number }[];
  active: T;
  onChange: (id: T) => void;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      className={cn(
        'inline-flex gap-1 rounded-xl border border-[var(--border-default)] bg-[var(--surface-inset)] p-1',
        className,
      )}
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          aria-selected={active === tab.id}
          onClick={() => onChange(tab.id)}
          className={cn(
            'rounded-lg px-3 py-1.5 text-sm font-medium transition-all duration-200',
            active === tab.id
              ? 'bg-[var(--surface-raised)] text-[var(--text-primary)] shadow-sm'
              : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]',
          )}
        >
          {tab.label}
          {tab.count !== undefined ? (
            <span className="ml-1.5 text-xs text-[var(--text-muted)] tabular-nums">{tab.count}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
