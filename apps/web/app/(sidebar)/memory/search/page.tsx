'use client';

import { useState, useMemo } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { DataTable } from '@/components/ui/data-table';
import { createMemoryColumns, type Memory } from '@/components/memory-columns';
import { Search, AlertCircle } from 'lucide-react';
import { I18nText } from '@/lib/i18n';

export default function MemorySearchPage() {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const columns = useMemo(() => createMemoryColumns({}), []);

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setIsSearching(true);
    setError(null);
    try {
      const response = await fetch('/api/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'memory.search', query: searchQuery, limit: 50 }),
      });
      const data = await response.json();
      if (data.error) { setError(data.error); return; }
      if (data.type === 'memory.search.result') setMemories(data.results);
    } catch {
      setError('Failed to connect to the server. Make sure the backend is running.');
    } finally {
      setIsSearching(false);
    }
  };

  return (
    <div className="flex-1 overflow-auto p-4">
      <div className="flex items-center gap-3 mb-2">
        <h1 className="text-lg font-semibold"><I18nText id="page.search" /></h1>
        {memories.length > 0 && (
          <Badge variant="secondary" className="text-xs">{memories.length} results</Badge>
        )}
      </div>
      <div className="h-px bg-gradient-to-r from-border via-border/40 to-transparent mb-4" />

      {error && (
        <div className="mb-4">
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Error</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        </div>
      )}

      <div className="space-y-4">
        <div className="flex gap-2">
          <Input
            placeholder="Search for memories..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            className="flex-1"
          />
          <Button onClick={handleSearch} disabled={isSearching}>
            <Search className="h-4 w-4 mr-2" />
            {isSearching ? 'Searching...' : 'Search'}
          </Button>
        </div>

        {memories.length > 0 && (
          <div>
            <p className="text-sm text-muted-foreground mb-3">
              Found {memories.length} matching {memories.length === 1 ? 'memory' : 'memories'}
            </p>
            <DataTable columns={columns} data={memories} searchKey="content" searchPlaceholder="Filter results..." />
          </div>
        )}

        {memories.length === 0 && searchQuery && !isSearching && (
          <p className="py-8 text-center text-muted-foreground">
            No memories found for &quot;{searchQuery}&quot;
          </p>
        )}

        {!searchQuery && (
          <p className="py-8 text-center text-muted-foreground">
            Enter a search query to find memories
          </p>
        )}
      </div>
    </div>
  );
}
