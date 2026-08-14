'use client';

import { Suspense, useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { LibraryGallery } from '@/components/library-gallery';
import { toast } from 'sonner';

interface Project {
  id: string;
  name: string;
}

const ALL_CATEGORIES_VALUE = '__all__';

export const CATEGORIES = ['ui', 'design-system', 'effects', 'animation', 'other'] as const;
export type Category = (typeof CATEGORIES)[number];

const CATEGORY_LABELS: Record<Category, string> = {
  'ui': 'UI',
  'design-system': 'Design System',
  'effects': 'Effects',
  'animation': 'Animation',
  'other': 'Other',
};

function isCategory(value: string): value is Category {
  return (CATEGORIES as readonly string[]).includes(value);
}

function LibraryPageContent() {
  const searchParams = useSearchParams();
  const [projects, setProjects] = useState<Project[]>([]);
  const [category, setCategory] = useState<Category | null>(null);

  useEffect(() => {
    const fromQuery = searchParams.get('category');
    if (fromQuery && isCategory(fromQuery)) {
      setCategory(fromQuery);
    }
    // Otherwise stays null — "All categories" is the default global gallery view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchProjects = useCallback(async () => {
    try {
      const res = await fetch('/api/projects');
      const data = await res.json();
      setProjects(data.projects ?? []);
    } catch {
      toast.error('Failed to load projects');
    }
  }, []);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-end gap-2 p-4 pb-0 shrink-0">
        <Select
          value={category ?? ALL_CATEGORIES_VALUE}
          onValueChange={(value) =>
            setCategory(value === ALL_CATEGORIES_VALUE ? null : (value as Category))
          }
        >
          <SelectTrigger className="h-8 w-[220px]">
            <SelectValue placeholder="All categories" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_CATEGORIES_VALUE}>All categories</SelectItem>
            {CATEGORIES.map((c) => (
              <SelectItem key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex-1 overflow-auto">
        <LibraryGallery category={category} projects={projects} />
      </div>
    </div>
  );
}

export default function LibraryPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading…</div>}>
      <LibraryPageContent />
    </Suspense>
  );
}
