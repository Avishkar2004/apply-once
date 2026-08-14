import type { ChangeEvent, ReactNode } from 'react';

/**
 * The shared control vocabulary for the options page and side panel
 * (ARCHITECTURE.md §8 — `src/ui/`). Tailwind is used here because these are
 * ordinary extension documents; the in-page overlay uses its own isolated
 * stylesheet instead (see `ui/overlay/styles.ts`).
 */

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900 ${className}`}
    >
      {children}
    </div>
  );
}

export function Section({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card>
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">{title}</h2>
          {description && <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{description}</p>}
        </div>
        {action}
      </div>
      {/* Columns are added as the window earns them, not all at once: five
          across a phone would be five unusable slivers. Anything that needs the
          whole row asks for `col-span-full`, which holds at every count. */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">{children}</div>
    </Card>
  );
}

const inputClass =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 disabled:bg-slate-100 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:focus:ring-indigo-900';

export function Label({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <span className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">
      {children}
      {hint && <span className="ml-2 font-normal text-slate-400">{hint}</span>}
    </span>
  );
}

export function TextField({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  hint,
  span,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
  hint?: string;
  span?: boolean;
}) {
  return (
    <label className={span ? 'col-span-full' : undefined}>
      <Label hint={hint}>{label}</Label>
      <input
        className={inputClass}
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
      />
    </label>
  );
}

export function TextArea({
  label,
  value,
  onChange,
  rows = 3,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  hint?: string;
}) {
  return (
    <label className="col-span-full">
      <Label hint={hint}>{label}</Label>
      <textarea
        className={inputClass}
        rows={rows}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
  hint,
}: {
  label: string;
  value: T | '';
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  hint?: string;
}) {
  return (
    <label>
      <Label hint={hint}>{label}</Label>
      <select className={inputClass} value={value} onChange={(event) => onChange(event.target.value as T)}>
        <option value="">—</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function CheckboxField({
  label,
  checked,
  onChange,
  description,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  description?: string;
}) {
  return (
    <label className="flex items-start gap-3 col-span-full">
      <input
        type="checkbox"
        className="mt-1 h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        <span className="block text-sm font-medium text-slate-700 dark:text-slate-300">{label}</span>
        {description && <span className="block text-sm text-slate-500 dark:text-slate-400">{description}</span>}
      </span>
    </label>
  );
}

export function Button({
  children,
  onClick,
  variant = 'secondary',
  disabled,
  type = 'button',
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  disabled?: boolean;
  type?: 'button' | 'submit';
}) {
  const variants = {
    primary: 'bg-indigo-600 text-white hover:bg-indigo-700 border-indigo-600',
    secondary:
      'bg-white text-slate-700 hover:bg-slate-50 border-slate-300 dark:bg-slate-800 dark:text-slate-200 dark:border-slate-600',
    danger: 'bg-white text-red-600 hover:bg-red-50 border-red-300',
    ghost: 'bg-transparent text-slate-500 hover:text-slate-800 border-transparent',
  } as const;

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${variants[variant]}`}
    >
      {children}
    </button>
  );
}

export function Banner({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warn' | 'error' | 'success';
  children: ReactNode;
}) {
  const tones = {
    info: 'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200',
    warn: 'border-amber-200 bg-amber-50 text-amber-900',
    error: 'border-red-200 bg-red-50 text-red-900',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  } as const;
  return <div className={`rounded-lg border px-4 py-3 text-sm ${tones[tone]}`}>{children}</div>;
}

/** A repeating list of entries with add/remove — work history, education, skills. */
export function ListEditor<T>({
  items,
  onChange,
  create,
  render,
  addLabel,
  emptyLabel,
}: {
  items: T[];
  onChange: (next: T[]) => void;
  create: () => T;
  render: (item: T, update: (patch: Partial<T>) => void, index: number) => ReactNode;
  addLabel: string;
  emptyLabel: string;
}) {
  const update = (index: number, patch: Partial<T>) => {
    onChange(items.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  };

  return (
    <div className="col-span-full">
      {items.length === 0 && <p className="mb-3 text-sm text-slate-500">{emptyLabel}</p>}
      <div className="space-y-4">
        {items.map((item, index) => (
          <div
            key={index}
            className="rounded-lg border border-slate-200 p-4 dark:border-slate-700"
          >
            <div className="mb-3 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                #{index + 1}
              </span>
              <Button variant="danger" onClick={() => onChange(items.filter((_, i) => i !== index))}>
                Remove
              </Button>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {render(item, (patch) => update(index, patch), index)}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-4">
        <Button onClick={() => onChange([...items, create()])}>{addLabel}</Button>
      </div>
    </div>
  );
}
