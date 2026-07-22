CREATE TABLE IF NOT EXISTS resources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('path', 'url')),
    location TEXT NOT NULL,
    description TEXT,
    tags TEXT[] NOT NULL DEFAULT '{}',
    env_param_key TEXT REFERENCES env_params(key) ON DELETE SET NULL,
    source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'env')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (kind, location)
);

CREATE INDEX IF NOT EXISTS idx_resources_kind ON resources(kind);
CREATE INDEX IF NOT EXISTS idx_resources_name ON resources(name);
CREATE INDEX IF NOT EXISTS idx_resources_env_param_key ON resources(env_param_key);
