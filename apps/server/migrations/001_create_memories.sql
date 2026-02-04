-- Create memories table
CREATE TABLE IF NOT EXISTS memories (
    id UUID PRIMARY KEY,
    user_id TEXT,
    content TEXT NOT NULL,
    summary TEXT,
    importance_score REAL NOT NULL DEFAULT 0.5,
    tags TEXT[] NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for user_id filtering
CREATE INDEX IF NOT EXISTS idx_memories_user_id ON memories(user_id);

-- Index for full-text search on content
CREATE INDEX IF NOT EXISTS idx_memories_content_gin ON memories USING gin(to_tsvector('english', content));

-- Index for created_at for sorting
CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at DESC);
