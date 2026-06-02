'use client';

import { useState, useMemo } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { DataTable } from '@/components/ui/data-table';
import { createMemoryColumns, type Memory } from '@/components/memory-columns';
import { Search, AlertCircle } from 'lucide-react';

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
      <div className="flex items-center gap-3 mb-4">
        <h1 className="text-lg font-semibold">Search</h1>
        {memories.length > 0 && (
          <Badge variant="secondary" className="text-xs">{memories.length} results</Badge>
        )}
      </div>

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
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Semantic Search</CardTitle>
            <CardDescription>Search memories using natural language queries</CardDescription>
          </CardHeader>
          <CardContent>
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
          </CardContent>
        </Card>

        {memories.length > 0 && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Search Results</CardTitle>
              <CardDescription>
                Found {memories.length} matching {memories.length === 1 ? 'memory' : 'memories'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <DataTable columns={columns} data={memories} searchKey="content" searchPlaceholder="Filter results..." />
            </CardContent>
          </Card>
        )}

        {memories.length === 0 && searchQuery && !isSearching && (
          <Card>
            <CardContent className="py-8 text-center text-muted-foreground">
              No memories found for &quot;{searchQuery}&quot;
            </CardContent>
          </Card>
        )}

        {!searchQuery && (
          <Card>
            <CardContent className="py-8 text-center text-muted-foreground">
              Enter a search query to find memories
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
