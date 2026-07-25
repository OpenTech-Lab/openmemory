'use client';

import { useState, KeyboardEvent } from 'react';
import { X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { BUILTIN_TASK_LABELS, TASK_LABEL_COLORS, CUSTOM_LABEL_COLOR } from '@/lib/task-labels';

interface LabelChipInputProps {
  value: string[];
  onChange: (labels: string[]) => void;
  builtins?: readonly string[];
  colors?: Record<string, string>;
  disabled?: boolean;
}

export function LabelChipInput({
  value,
  onChange,
  builtins = BUILTIN_TASK_LABELS,
  colors = TASK_LABEL_COLORS,
  disabled,
}: LabelChipInputProps) {
  const [draft, setDraft] = useState('');

  const toggle = (label: string) => {
    if (value.includes(label)) onChange(value.filter(l => l !== label));
    else onChange([...value, label]);
  };

  const addCustom = () => {
    const label = draft.trim().toLowerCase();
    setDraft('');
    if (!label || value.includes(label)) return;
    onChange([...value, label]);
  };

  const remove = (label: string) => onChange(value.filter(l => l !== label));

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addCustom();
    }
  };

  const customSelected = value.filter(l => !builtins.includes(l));

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {builtins.map(label => {
          const selected = value.includes(label);
          return (
            <button
              key={label}
              type="button"
              disabled={disabled}
              onClick={() => toggle(label)}
              className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border transition-colors ${
                selected
                  ? (colors[label] ?? CUSTOM_LABEL_COLOR) + ' bg-muted'
                  : 'border-border text-muted-foreground hover:bg-muted'
              }`}
            >
              {label}
              {selected && <X className="h-2.5 w-2.5" />}
            </button>
          );
        })}
        {customSelected.map(label => (
          <span
            key={label}
            className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border bg-muted ${colors[label] ?? CUSTOM_LABEL_COLOR}`}
          >
            {label}
            <button type="button" disabled={disabled} onClick={() => remove(label)}>
              <X className="h-2.5 w-2.5" />
            </button>
          </span>
        ))}
      </div>
      <Input
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={addCustom}
        placeholder="Add a custom label and press Enter"
        disabled={disabled}
        className="h-7 text-xs"
      />
    </div>
  );
}
