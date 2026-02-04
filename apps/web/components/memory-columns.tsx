'use client';

import { ColumnDef } from '@tanstack/react-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ArrowUpDown, MoreHorizontal, Eye, Pencil, Trash2, Copy } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export interface Memory {
  id: string;
  content: string;
  summary: string | null;
  tags: string[];
  importance_score: number;
  created_at: string;
  updated_at?: string;
  score?: number;
}

export interface MemoryActions {
  onView?: (memory: Memory) => void;
  onEdit?: (memory: Memory) => void;
  onDelete?: (memory: Memory) => void;
}

export function createMemoryColumns(actions?: MemoryActions): ColumnDef<Memory>[] {
  return [
    {
      accessorKey: 'id',
      header: 'ID',
      cell: ({ row }) => (
        <span className="font-mono text-xs text-muted-foreground">
          {row.getValue<string>('id').slice(0, 8)}...
        </span>
      ),
    },
    {
      accessorKey: 'content',
      header: ({ column }) => (
        <Button
          variant="ghost"
          onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
          className="-ml-4"
        >
          Content
          <ArrowUpDown className="ml-2 h-4 w-4" />
        </Button>
      ),
      cell: ({ row }) => (
        <div className="max-w-[400px] truncate" title={row.getValue('content')}>
          {row.getValue('content')}
        </div>
      ),
    },
    {
      accessorKey: 'summary',
      header: 'Summary',
      cell: ({ row }) => {
        const summary = row.getValue<string | null>('summary');
        return summary ? (
          <div className="max-w-[200px] truncate text-muted-foreground" title={summary}>
            {summary}
          </div>
        ) : (
          <span className="text-muted-foreground/50">—</span>
        );
      },
    },
    {
      accessorKey: 'tags',
      header: 'Tags',
      cell: ({ row }) => {
        const tags = row.getValue<string[]>('tags');
        return (
          <div className="flex flex-wrap gap-1">
            {tags.length > 0 ? (
              tags.slice(0, 3).map((tag) => (
                <Badge key={tag} variant="secondary" className="text-xs">
                  {tag}
                </Badge>
              ))
            ) : (
              <span className="text-muted-foreground/50">—</span>
            )}
            {tags.length > 3 && (
              <Badge variant="outline" className="text-xs">
                +{tags.length - 3}
              </Badge>
            )}
          </div>
        );
      },
      filterFn: (row, id, value) => {
        const tags = row.getValue<string[]>(id);
        return tags.some((tag) => tag.toLowerCase().includes(value.toLowerCase()));
      },
    },
    {
      accessorKey: 'importance_score',
      header: ({ column }) => (
        <Button
          variant="ghost"
          onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
          className="-ml-4"
        >
          Importance
          <ArrowUpDown className="ml-2 h-4 w-4" />
        </Button>
      ),
      cell: ({ row }) => {
        const score = row.getValue<number>('importance_score');
        return (
          <div className="flex items-center gap-2">
            <div className="h-2 w-16 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${score * 100}%` }}
              />
            </div>
            <span className="text-xs text-muted-foreground">{score.toFixed(1)}</span>
          </div>
        );
      },
    },
    {
      accessorKey: 'score',
      header: ({ column }) => (
        <Button
          variant="ghost"
          onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
          className="-ml-4"
        >
          Relevance
          <ArrowUpDown className="ml-2 h-4 w-4" />
        </Button>
      ),
      cell: ({ row }) => {
        const score = row.getValue<number | undefined>('score');
        return score !== undefined ? (
          <Badge variant="outline">{score.toFixed(2)}</Badge>
        ) : (
          <span className="text-muted-foreground/50">—</span>
        );
      },
    },
    {
      accessorKey: 'created_at',
      header: ({ column }) => (
        <Button
          variant="ghost"
          onClick={() => column.toggleSorting(column.getIsSorted() === 'asc')}
          className="-ml-4"
        >
          Created
          <ArrowUpDown className="ml-2 h-4 w-4" />
        </Button>
      ),
      cell: ({ row }) => {
        const date = new Date(row.getValue('created_at'));
        return (
          <span className="text-sm text-muted-foreground">
            {date.toLocaleDateString()} {date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        );
      },
    },
    {
      id: 'actions',
      cell: ({ row }) => {
        const memory = row.original;
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="h-8 w-8 p-0">
                <span className="sr-only">Open menu</span>
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Actions</DropdownMenuLabel>
              <DropdownMenuItem onClick={() => navigator.clipboard.writeText(memory.id)}>
                <Copy className="mr-2 h-4 w-4" />
                Copy ID
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => navigator.clipboard.writeText(memory.content)}>
                <Copy className="mr-2 h-4 w-4" />
                Copy content
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => actions?.onView?.(memory)}>
                <Eye className="mr-2 h-4 w-4" />
                View details
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => actions?.onEdit?.(memory)}>
                <Pencil className="mr-2 h-4 w-4" />
                Edit
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => actions?.onDelete?.(memory)}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        );
      },
    },
  ];
}

// Default columns without actions (for backwards compatibility)
export const memoryColumns = createMemoryColumns();
