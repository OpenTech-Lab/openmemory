use super::*;

impl McpServer {
    pub(super) async fn handle_tools_list(&self) -> Result<serde_json::Value> {
        Ok(json!({
            "tools": [
                {
                    "name": "memory_save",
                    "description": "Save important information to memory for later recall",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "content": {
                                "type": "string",
                                "description": "The content to remember"
                            },
                            "summary": {
                                "type": "string",
                                "description": "Optional short summary"
                            },
                            "importance": {
                                "type": "number",
                                "description": "Importance score 0.0-1.0 (default 0.5)"
                            },
                            "tags": {
                                "type": "array",
                                "items": {"type": "string"},
                                "description": "Optional tags for categorization"
                            }
                        },
                        "required": ["content"]
                    }
                },
                {
                    "name": "memory_search",
                    "description": "Search memories by keywords and return most relevant results",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "query": {
                                "type": "string",
                                "description": "Search query (keywords)"
                            },
                            "limit": {
                                "type": "number",
                                "description": "Max results to return (default 5)"
                            }
                        },
                        "required": ["query"]
                    }
                },
                {
                    "name": "memory_graph_neighbors",
                    "description": "Find memories related to a given memory via graph traversal (1-2 hops through shared tags or explicit links)",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "id": {
                                "type": "string",
                                "format": "uuid",
                                "description": "UUID of the source memory"
                            },
                            "hops": {
                                "type": "integer",
                                "minimum": 1,
                                "maximum": 2,
                                "description": "Traversal depth: 1 = direct neighbors, 2 = neighbors of neighbors (default 1)"
                            },
                            "limit": {
                                "type": "integer",
                                "minimum": 1,
                                "maximum": 50,
                                "description": "Max neighbors to return (default 10)"
                            },
                            "user_id": {
                                "type": "string",
                                "description": "Optional user ID — restricts traversal to the caller's own memories"
                            }
                        },
                        "required": ["id"]
                    }
                },
                {
                    "name": "memory_graph_relate",
                    "description": "Explicitly link two memories with a named relationship type",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "from_id": {
                                "type": "string",
                                "format": "uuid",
                                "description": "UUID of the source memory"
                            },
                            "to_id": {
                                "type": "string",
                                "format": "uuid",
                                "description": "UUID of the target memory"
                            },
                            "relationship": {
                                "type": "string",
                                "description": "Named relationship type (e.g. 'causes', 'contradicts', 'extends')"
                            },
                            "user_id": {
                                "type": "string",
                                "description": "Optional user ID — both memories must belong to this user"
                            }
                        },
                        "required": ["from_id", "to_id", "relationship"]
                    }
                },
                {
                    "name": "graph_add_episode",
                    "description": "Add an immutable source episode to the knowledge graph (ground truth record)",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string", "description": "Episode name"},
                            "source": {"type": "string", "description": "message | json | text | event"},
                            "source_description": {"type": "string", "description": "Description of the data source"},
                            "content": {"type": "string", "description": "Raw episode content"},
                            "group_id": {"type": "string", "description": "Namespace (default: 'default')"},
                            "valid_at": {"type": "string", "description": "ISO8601 UTC timestamp when this became true"}
                        },
                        "required": ["name", "source", "source_description", "content"]
                    }
                },
                {
                    "name": "graph_add_entity",
                    "description": "Upsert a real-world entity into the knowledge graph (deduped on name+type+group_id)",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string"},
                            "entity_type": {"type": "string", "description": "e.g. Person, Place, Organization, Concept"},
                            "group_id": {"type": "string"},
                            "summary": {"type": "string"},
                            "episode_id": {"type": "string", "description": "UUID of source episode for provenance"}
                        },
                        "required": ["name", "entity_type"]
                    }
                },
                {
                    "name": "graph_add_fact",
                    "description": "Create a temporal fact (relationship) between two entities",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "subject": {"type": "string", "description": "Subject entity name"},
                            "subject_type": {"type": "string"},
                            "object": {"type": "string", "description": "Object entity name"},
                            "object_type": {"type": "string"},
                            "name": {"type": "string", "description": "Relationship name e.g. manages, lives_in, owns"},
                            "fact": {"type": "string", "description": "Human-readable fact statement"},
                            "group_id": {"type": "string"},
                            "episode_id": {"type": "string"},
                            "valid_at": {"type": "string", "description": "ISO8601 UTC timestamp"},
                            "invalidate_previous": {"type": "boolean", "description": "If true, expire prior facts with same name between these entities"}
                        },
                        "required": ["subject", "subject_type", "object", "object_type", "name", "fact"]
                    }
                },
                {
                    "name": "graph_query_facts",
                    "description": "Search facts by keyword across entity names, relationship names, and fact text",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "query": {"type": "string"},
                            "group_id": {"type": "string"},
                            "limit": {"type": "number"},
                            "valid_only": {"type": "boolean", "description": "If true, only return currently valid facts"}
                        },
                        "required": ["query"]
                    }
                },
                {
                    "name": "graph_query_at",
                    "description": "Retrieve all facts that were valid at a specific point in time",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "timestamp": {"type": "string", "description": "ISO8601 UTC timestamp to query at"},
                            "entity_name": {"type": "string", "description": "Filter by entity name"},
                            "group_id": {"type": "string"},
                            "limit": {"type": "number"}
                        },
                        "required": ["timestamp"]
                    }
                },
                {
                    "name": "graph_get_entity_history",
                    "description": "Get the full history of facts (current and historical) involving an entity",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "entity_name": {"type": "string"},
                            "group_id": {"type": "string"},
                            "limit": {"type": "number"}
                        },
                        "required": ["entity_name"]
                    }
                },
                {
                    "name": "graph_get_entity",
                    "description": "Look up a single entity by name, optionally filtered by type and group",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "entity_name": {"type": "string"},
                            "entity_type": {"type": "string"},
                            "group_id": {"type": "string"}
                        },
                        "required": ["entity_name"]
                    }
                },
                {
                    "name": "env_set",
                    "description": "Store an environment parameter or secret. Use is_secret=true for sensitive values like API keys — secret values cannot be read back by agents, only by the web UI.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "key": {
                                "type": "string",
                                "description": "Parameter name (e.g. OPENAI_API_KEY)"
                            },
                            "value": {
                                "type": "string",
                                "description": "Parameter value (stored encrypted)"
                            },
                            "is_secret": {
                                "type": "boolean",
                                "description": "If true, agents cannot read the value back (default false)"
                            },
                            "description": {
                                "type": "string",
                                "description": "Optional human-readable description"
                            }
                        },
                        "required": ["key", "value"]
                    }
                },
                {
                    "name": "env_get",
                    "description": "Get the value of a normal (non-secret) environment parameter. Returns an error for secret parameters — use env_list to check if a key exists.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "key": {
                                "type": "string",
                                "description": "Parameter name to retrieve"
                            }
                        },
                        "required": ["key"]
                    }
                },
                {
                    "name": "env_rename",
                    "description": "Rename an environment parameter while preserving its encrypted value and metadata. Optional fields can replace them in the same transaction; resource links that reference the old key are updated.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "old_key": {
                                "type": "string",
                                "description": "Current parameter name"
                            },
                            "new_key": {
                                "type": "string",
                                "description": "New parameter name"
                            },
                            "value": {
                                "type": "string",
                                "description": "Optional replacement value; omit to preserve the current value"
                            },
                            "is_secret": {
                                "type": "boolean",
                                "description": "Optional replacement for the secret flag"
                            },
                            "description": {
                                "type": ["string", "null"],
                                "description": "Optional replacement description; null clears it"
                            }
                        },
                        "required": ["old_key", "new_key"]
                    }
                },
                {
                    "name": "env_list",
                    "description": "List all environment parameters. Returns key names, descriptions, and is_secret flag — never returns values.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {}
                    }
                },
                {
                    "name": "env_delete",
                    "description": "Delete an environment parameter by key name.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "key": {
                                "type": "string",
                                "description": "Parameter name to delete"
                            }
                        },
                        "required": ["key"]
                    }
                },
                {
                    "name": "resource_list",
                    "description": "List materials/resources the user has registered: local paths and website URLs. Merges manual catalog entries with env-declared roots (RESOURCE_PATH.<slug>, RESOURCE_URL.<slug>). Use at session start when tasks involve files, datasets, docs, or external sites. A resource's env_param_keys can bundle several credential/config fields for one account (e.g. api_key + team_id + token) — use env_http_request / env_get with those key names, never invent paths.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "kind": {
                                "type": "string",
                                "description": "Filter: path | url",
                                "enum": ["path", "url"]
                            },
                            "tags": {
                                "type": "array",
                                "items": {"type": "string"},
                                "description": "Filter by tags (manual resources only) — matches resources with ANY of the given tags. Use resource_tags to see the current tag vocabulary."
                            },
                            "query": {
                                "type": "string",
                                "description": "Substring match on name, location, description, tags"
                            }
                        }
                    }
                },
                {
                    "name": "resource_tags",
                    "description": "List the distinct tags currently used across manual resources, with usage counts (most-used first). Call this before filtering resource_list by tags to see what's available.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {}
                    }
                },
                {
                    "name": "resource_get",
                    "description": "Get one resource by UUID (manual) or by name / env slug.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "id_or_name": {
                                "type": "string",
                                "description": "Resource UUID, name, or env slug"
                            }
                        },
                        "required": ["id_or_name"]
                    }
                },
                {
                    "name": "resource_add",
                    "description": "Register a local path or website URL in the resource catalog so future agents can discover it. Optionally link env_param_keys — a list of existing env_params to bundle as one account's credentials/config (e.g. api_key + team_id + token). For env-only declaration without a catalog row, use env_set with key RESOURCE_PATH.<slug> or RESOURCE_URL.<slug> (normal, not secret).",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string", "description": "Short unique label"},
                            "kind": {"type": "string", "enum": ["path", "url"]},
                            "location": {"type": "string", "description": "Absolute filesystem path or URL"},
                            "description": {"type": "string"},
                            "tags": {"type": "array", "items": {"type": "string"}},
                            "env_param_keys": {"type": "array", "items": {"type": "string"}, "description": "Existing env_params keys to bundle as this resource's credentials/config"}
                        },
                        "required": ["name", "kind", "location"]
                    }
                },
                {
                    "name": "resource_update",
                    "description": "Update a manual resource by UUID. Env-sourced resources must be changed via env_set / env_delete on RESOURCE_* keys.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "id": {"type": "string", "description": "Resource UUID"},
                            "name": {"type": "string"},
                            "kind": {"type": "string", "enum": ["path", "url"]},
                            "location": {"type": "string"},
                            "description": {"type": "string"},
                            "tags": {"type": "array", "items": {"type": "string"}},
                            "env_param_keys": {"type": "array", "items": {"type": "string"}, "description": "Replaces the full set of linked credential/config keys. Pass [] to clear all."},
                            "clear_description": {"type": "boolean", "description": "If true, clear description"}
                        },
                        "required": ["id"]
                    }
                },
                {
                    "name": "resource_delete",
                    "description": "Delete a manual resource by UUID. For env-sourced resources, delete the RESOURCE_PATH.* / RESOURCE_URL.* env key instead.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "id": {"type": "string", "description": "Resource UUID"}
                        },
                        "required": ["id"]
                    }
                },
                {
                    "name": "library_add",
                    "description": "Register a visual/media/code candidate (image, video, or live HTML/CSS/JS snippet) in the global library — e.g. a generated icon render, preview frame, or interactive prototype worth keeping around to browse and compare later. For image/video, `location` must be a file path (or URL) you've already produced. For `kind: code`, provide `code` (self-contained HTML, rendered live in a sandboxed iframe) instead of — or in addition to — `location`. This tool only catalogs the content, it does not render, copy, or validate it. Storage + listing only — there's no pending/picked/rejected review-state tracking here. `project_id` is optional — omit it to keep the entry unscoped, like a global resource.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "project_id": {"type": "string", "description": "Optional project UUID to loosely associate this entry with"},
                            "label": {"type": "string", "description": "Short label for this candidate"},
                            "kind": {"type": "string", "enum": ["image", "video", "code"]},
                            "category": {"type": "string", "enum": ["ui", "design-system", "effects", "animation", "other"], "description": "Required browse category"},
                            "location": {"type": "string", "description": "Absolute filesystem path (or URL) to the already-generated image/video/html file"},
                            "code": {"type": "string", "description": "Self-contained HTML/CSS/JS to preview live (kind: code only)"},
                            "description": {"type": "string"},
                            "tags": {"type": "array", "items": {"type": "string"}}
                        },
                        "required": ["label", "kind", "category"]
                    }
                },
                {
                    "name": "library_list",
                    "description": "List library entries (visual/media/code candidates), optionally filtered to a project, a tag, and/or a category. Omit project_id to list across all projects.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "project_id": {"type": "string", "description": "Optional project UUID filter"},
                            "tag": {"type": "string", "description": "Filter to entries containing this tag"},
                            "category": {"type": "string", "enum": ["ui", "design-system", "effects", "animation", "other"], "description": "Filter to this category"}
                        },
                        "required": []
                    }
                },
                {
                    "name": "library_get",
                    "description": "Get one library entry by UUID.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "id": {"type": "string", "description": "Library entry UUID"}
                        },
                        "required": ["id"]
                    }
                },
                {
                    "name": "library_delete",
                    "description": "Delete a library entry by UUID.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "id": {"type": "string", "description": "Library entry UUID"}
                        },
                        "required": ["id"]
                    }
                },
                {
                    "name": "env_http_request",
                    "description": "Make an HTTP request with a stored secret injected as the auth header (default) or as the full request URL itself. The secret value is never exposed to the agent — the server resolves it internally and forwards the request. Use auth-header mode for API keys/tokens (Cloudflare, GitHub, etc.). Use secret_target='url' for self-authenticating URLs like incoming webhooks (e.g. AWS Amplify build webhooks), where the URL itself is the credential — in that mode omit 'url' entirely. If OPENMEMORY_HTTP_ALLOWED_HOSTS is configured on the server, requests to hosts outside that allowlist are rejected before the secret is resolved.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "method": {
                                "type": "string",
                                "description": "HTTP method: GET, POST, PUT, PATCH, DELETE",
                                "enum": ["GET", "POST", "PUT", "PATCH", "DELETE"]
                            },
                            "url": {
                                "type": "string",
                                "description": "Full URL to request. Required unless secret_target='url' (in which case the secret itself is the URL and this is ignored)."
                            },
                            "auth_key": {
                                "type": "string",
                                "description": "Name of the secret env param whose value will be used as the auth credential (e.g. CLAUDEFLARE_API_TOKEN_ACCESS), or as the full URL when secret_target='url'"
                            },
                            "secret_target": {
                                "type": "string",
                                "description": "Where the secret goes: 'header' (default) puts it in an auth header alongside the 'url' arg; 'url' means the secret itself IS the full request URL (no auth header sent) — for self-authenticating URLs like incoming webhooks; 'query' appends the secret as a URL query parameter (name from secret_query_param, default 'key') — for APIs that require the key in the query string, like Pixabay.",
                                "enum": ["header", "url", "query"]
                            },
                            "auth_header": {
                                "type": "string",
                                "description": "Header name for the credential. Defaults to 'Authorization'. Ignored when secret_target='url'."
                            },
                            "auth_prefix": {
                                "type": "string",
                                "description": "Prefix for the header value. Defaults to 'Bearer '. Set to '' for bare token headers like X-Auth-Key. Ignored when secret_target='url'."
                            },
                            "secret_query_param": {
                                "type": "string",
                                "description": "Query parameter name for the secret when secret_target='query'. Defaults to 'key'."
                            },
                            "body": {
                                "type": "object",
                                "description": "Optional JSON request body (for POST/PUT/PATCH)"
                            },
                            "headers": {
                                "type": "object",
                                "description": "Optional additional headers as key-value pairs"
                            }
                        },
                        "required": ["method", "auth_key"]
                    }
                },
                {
                    "name": "env_http_download",
                    "description": "Like env_http_request, but for binary responses (video, images, archives, any non-text payload): the server streams the response bytes straight to a file on local disk instead of returning them as a JSON/text string. Use this whenever the response isn't text/JSON — env_http_request reads the body as UTF-8 text and silently corrupts binary data (invalid byte sequences get replaced with U+FFFD), so it must never be used for downloads. Only metadata (path, size, content-type, status) is returned to the agent — never the bytes. save_path must be an absolute path; parent directories are created if missing and an existing file at that path is overwritten.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "method": {
                                "type": "string",
                                "description": "HTTP method: GET, POST, PUT, PATCH, DELETE",
                                "enum": ["GET", "POST", "PUT", "PATCH", "DELETE"]
                            },
                            "url": {
                                "type": "string",
                                "description": "Full URL to request. Required unless secret_target='url' (in which case the secret itself is the URL and this is ignored)."
                            },
                            "auth_key": {
                                "type": "string",
                                "description": "Name of the secret env param whose value will be used as the auth credential, or as the full URL when secret_target='url'"
                            },
                            "secret_target": {
                                "type": "string",
                                "description": "Where the secret goes: 'header' (default) puts it in an auth header alongside the 'url' arg; 'url' means the secret itself IS the full request URL (no auth header sent); 'query' appends the secret as a URL query parameter (name from secret_query_param, default 'key') — for APIs that require the key in the query string, like Pixabay.",
                                "enum": ["header", "url", "query"]
                            },
                            "auth_header": {
                                "type": "string",
                                "description": "Header name for the credential. Defaults to 'Authorization'. Ignored when secret_target='url'."
                            },
                            "auth_prefix": {
                                "type": "string",
                                "description": "Prefix for the header value. Defaults to 'Bearer '. Set to '' for bare token headers like X-Auth-Key. Ignored when secret_target='url'."
                            },
                            "secret_query_param": {
                                "type": "string",
                                "description": "Query parameter name for the secret when secret_target='query'. Defaults to 'key'."
                            },
                            "headers": {
                                "type": "object",
                                "description": "Optional additional headers as key-value pairs"
                            },
                            "save_path": {
                                "type": "string",
                                "description": "Absolute local filesystem path to write the downloaded bytes to. Parent directories are created if needed; an existing file is overwritten."
                            }
                        },
                        "required": ["method", "auth_key", "save_path"]
                    }
                },
                {
                    "name": "env_sign_jwt",
                    "description": "Sign a JWT using a stored secret as the signing key and return the token. The raw key value is never exposed to the agent, but the returned token IS a live, usable bearer credential for its ttl_seconds lifetime — prefer env_http_request_jwt when you just need to call an API, since that keeps the token server-side too and never returns it. exp/iat are added automatically from ttl_seconds — do not pass them in claims.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "key": {
                                "type": "string",
                                "description": "Name of the secret env param holding the signing key (PEM for ES256/RS256, raw string for HS256)"
                            },
                            "algorithm": {
                                "type": "string",
                                "description": "JWT signing algorithm",
                                "enum": ["ES256", "RS256", "HS256"]
                            },
                            "header_extra": {
                                "type": "object",
                                "description": "Extra JWT header fields, e.g. {\"kid\": \"...\"}"
                            },
                            "claims": {
                                "type": "object",
                                "description": "JWT claims, e.g. {\"iss\": \"...\", \"aud\": \"appstoreconnect-v1\"}. iat/exp are added automatically."
                            },
                            "ttl_seconds": {
                                "type": "integer",
                                "description": "Token lifetime in seconds. Default 1200, capped at 1200."
                            },
                            "key_from_file": {
                                "type": "boolean",
                                "description": "Set true if 'key' was stored via env_set_file (base64-encoded) — decodes back to raw bytes before signing. Default false (for keys stored via env_set as plain text)."
                            }
                        },
                        "required": ["key", "algorithm", "claims"]
                    }
                },
                {
                    "name": "env_http_request_jwt",
                    "description": "Make an HTTP request authenticated with a freshly-signed JWT, all server-side — the signing key and the resulting token both stay on the server; only the API response is returned to the agent. Use this instead of env_sign_jwt + a separate request whenever you're just calling an API (e.g. App Store Connect: algorithm=ES256, header_extra={\"kid\":...}, claims={\"iss\":...,\"aud\":\"appstoreconnect-v1\"}). exp/iat are added automatically from ttl_seconds — do not pass them in claims.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "method": {
                                "type": "string",
                                "description": "HTTP method: GET, POST, PUT, PATCH, DELETE",
                                "enum": ["GET", "POST", "PUT", "PATCH", "DELETE"]
                            },
                            "url": {
                                "type": "string",
                                "description": "Full URL to request"
                            },
                            "key": {
                                "type": "string",
                                "description": "Name of the secret env param holding the signing key (PEM for ES256/RS256, raw string for HS256)"
                            },
                            "algorithm": {
                                "type": "string",
                                "description": "JWT signing algorithm",
                                "enum": ["ES256", "RS256", "HS256"]
                            },
                            "header_extra": {
                                "type": "object",
                                "description": "Extra JWT header fields, e.g. {\"kid\": \"...\"}"
                            },
                            "claims": {
                                "type": "object",
                                "description": "JWT claims, e.g. {\"iss\": \"...\", \"aud\": \"appstoreconnect-v1\"}. iat/exp are added automatically."
                            },
                            "ttl_seconds": {
                                "type": "integer",
                                "description": "Token lifetime in seconds. Default 1200, capped at 1200."
                            },
                            "body": {
                                "type": "object",
                                "description": "Optional JSON request body (for POST/PUT/PATCH)"
                            },
                            "headers": {
                                "type": "object",
                                "description": "Optional additional headers as key-value pairs"
                            },
                            "key_from_file": {
                                "type": "boolean",
                                "description": "Set true if 'key' was stored via env_set_file (base64-encoded) — decodes back to raw bytes before signing. Default false (for keys stored via env_set as plain text)."
                            }
                        },
                        "required": ["method", "url", "key", "algorithm", "claims"]
                    }
                },
                {
                    "name": "env_set_file",
                    "description": "Store a local file's contents as an env secret. The server reads the file from disk and encrypts it directly — the agent never has to pass the file's bytes as a tool argument, so raw file content never appears in the agent's own tool calls or transcript. Use this for uploading credential files (service account JSON, .p8/.p12 keys, certs) instead of env_set. Always stored as a secret (unreadable by agents) and base64-encoded internally, so both text and binary files work. Use env_http_request / env_http_request_jwt / env_sign_jwt afterward to use the stored file safely.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "key": {
                                "type": "string",
                                "description": "Parameter name to store the file under"
                            },
                            "file_path": {
                                "type": "string",
                                "description": "Absolute path to the file on disk (server reads it directly)"
                            },
                            "description": {
                                "type": "string",
                                "description": "Optional human-readable description"
                            }
                        },
                        "required": ["key", "file_path"]
                    }
                },
                {
                    "name": "env_google_service_account_request",
                    "description": "Call a Google Cloud / Google API authenticated as a service account, entirely server-side. Reads a GCP service account JSON secret (as stored by env_set_file), extracts client_email/private_key/token_uri from it, signs the RS256 JWT assertion, exchanges it for an OAuth2 access token at Google's token endpoint, then makes the actual API request with that token — none of the private key, JWT assertion, or access token ever reach the agent. Only the final API response is returned.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "key": {
                                "type": "string",
                                "description": "Name of the secret env param holding the full GCP service account JSON (base64, as stored by env_set_file)"
                            },
                            "scopes": {
                                "type": "array",
                                "items": {"type": "string"},
                                "description": "OAuth2 scopes to request, e.g. [\"https://www.googleapis.com/auth/cloud-platform\"]"
                            },
                            "method": {
                                "type": "string",
                                "description": "HTTP method for the target API request",
                                "enum": ["GET", "POST", "PUT", "PATCH", "DELETE"]
                            },
                            "url": {
                                "type": "string",
                                "description": "Full URL of the target Google API request"
                            },
                            "body": {
                                "type": "object",
                                "description": "Optional JSON request body (for POST/PUT/PATCH)"
                            },
                            "headers": {
                                "type": "object",
                                "description": "Optional additional headers as key-value pairs"
                            }
                        },
                        "required": ["key", "scopes", "method", "url"]
                    }
                },
                {
                    "name": "env_ssh_execute",
                    "description": "Run a shell command on a remote host over SSH, entirely server-side — the private key and username are resolved from encrypted env params and used to authenticate, but never returned to the agent. Only stdout, stderr, and the exit code come back. Requires OPENMEMORY_SSH_ALLOWED_HOSTS to be set on the openmemory-mcp process (fail-closed: unset or empty means every host is refused) and, on first use of a given key, a pinned '<ssh_key_key>.host_key_fingerprint' env param (set via env_set to the output of `ssh-keyscan -t ed25519,rsa <host> | ssh-keygen -lf -`) to prevent man-in-the-middle host substitution. Optionally scope a key to specific hosts with a '<ssh_key_key>.allowed_hosts' env param (comma-separated host or host:port entries). No PTY, no port/agent forwarding, no password auth.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "host": {
                                "type": "string",
                                "description": "Hostname or IP of the remote server"
                            },
                            "port": {
                                "type": "integer",
                                "description": "SSH port (default 22)"
                            },
                            "ssh_key_key": {
                                "type": "string",
                                "description": "Name of the secret env param holding the private key (PEM, or base64-wrapped as stored by env_set_file — auto-detected)"
                            },
                            "username_key": {
                                "type": "string",
                                "description": "Name of the env param holding the SSH username. Exactly one of username_key/username is required."
                            },
                            "username": {
                                "type": "string",
                                "description": "The SSH username directly, if not stored as an env param. Exactly one of username_key/username is required."
                            },
                            "passphrase_key": {
                                "type": "string",
                                "description": "Optional: name of the secret env param holding the private key's passphrase, if it's encrypted"
                            },
                            "command": {
                                "type": "string",
                                "description": "Shell command to run on the remote host"
                            },
                            "timeout_seconds": {
                                "type": "integer",
                                "description": "Timeout for connect+auth+exec combined. Default 30, capped at 300."
                            }
                        },
                        "required": ["host", "ssh_key_key", "command"]
                    }
                },
                {
                    "name": "project_graph_list",
                    "description": "List all registered project knowledge graphs. Start here to find project_id, name, path, and node/edge counts. Use name or path to find the right project.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {}
                    }
                },
                {
                    "name": "project_graph_create",
                    "description": "Register a local folder as a project. The folder is indexed automatically (tree-sitter parsing of Rust/TypeScript/JavaScript/Python source, plus file nodes for other recognized file types) — no external tool needed.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string", "description": "Display name for this project"},
                            "path": {"type": "string", "description": "Absolute path to the project folder"},
                            "description": {"type": "string", "description": "Optional description"}
                        },
                        "required": ["name", "path"]
                    }
                },
                {
                    "name": "project_graph_query",
                    "description": "Search a project knowledge graph by keyword using IDF-weighted BFS. Returns nodes 2 hops out from matches. Best for 'how does X connect to Y?' questions. Use project_id OR name/path to identify the project.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "project_id": {"type": "string", "description": "UUID of the project (from project_graph_list)"},
                            "name": {"type": "string", "description": "Project name (alternative to project_id)"},
                            "path": {"type": "string", "description": "Project path (alternative to project_id)"},
                            "q": {"type": "string", "description": "Keyword to search for in node labels (case-insensitive)"},
                            "hops": {"type": "integer", "description": "BFS depth from matching nodes (default: 2, max: 4)"},
                            "limit": {"type": "integer", "description": "Max nodes to return (default: 50, max: 200)"}
                        },
                        "required": ["q"]
                    }
                },
                {
                    "name": "project_graph_node_detail",
                    "description": "Get full details for a specific node including all direct edges (in and out). Use after project_graph_query to drill into a specific node.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "project_id": {"type": "string"},
                            "name": {"type": "string", "description": "Project name (alternative to project_id)"},
                            "path": {"type": "string", "description": "Project path (alternative to project_id)"},
                            "node_id": {"type": "string", "description": "The node id (from graph query results)"}
                        },
                        "required": ["node_id"]
                    }
                },
                {
                    "name": "project_graph_shortest_path",
                    "description": "Find the shortest path between two nodes in a project knowledge graph.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "project_id": {"type": "string"},
                            "name": {"type": "string"},
                            "path": {"type": "string"},
                            "from_node": {"type": "string", "description": "Starting node id"},
                            "to_node": {"type": "string", "description": "Ending node id"}
                        },
                        "required": ["from_node", "to_node"]
                    }
                },
                {
                    "name": "project_graph_god_nodes",
                    "description": "Find the most-connected nodes (hubs) in the project graph. Good starting points for orientation.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "project_id": {"type": "string"},
                            "name": {"type": "string"},
                            "path": {"type": "string"},
                            "top_n": {"type": "integer", "description": "How many top nodes to return (default: 10)"}
                        }
                    }
                },
                {
                    "name": "project_graph_delete",
                    "description": "Delete a registered project graph from the database. Original files on disk are not affected.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "project_id": {"type": "string", "description": "UUID of the project to delete"},
                            "name": {"type": "string", "description": "Project name (alternative to project_id)"}
                        }
                    }
                },
                {
                    "name": "project_graph_rebuild",
                    "description": "Re-index a project's folder from disk (tree-sitter parsing of source files). Run after the codebase changes. Skips if the resulting graph is unchanged.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "project_id": {"type": "string"},
                            "name": {"type": "string"},
                            "path": {"type": "string"}
                        }
                    }
                },
                {
                    "name": "workflow_list",
                    "description": "List reusable deterministic workflows configured in OpenMemory. Use this to discover fixed processes before manually reproducing a recurring integration sequence.",
                    "inputSchema": {"type": "object", "properties": {}}
                },
                {
                    "name": "workflow_get",
                    "description": "Get a workflow definition and its expected input schema by UUID or name.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {"id_or_name": {"type": "string"}},
                        "required": ["id_or_name"]
                    }
                },
                {
                    "name": "workflow_run",
                    "description": "Start a configured workflow. HTTP nodes execute server-side. For an agent node, perform the returned action_required exactly, then call workflow_continue with its result. Repeat until status is completed.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "id_or_name": {"type": "string", "description": "Workflow UUID or unique name"},
                            "input": {"type": "object", "description": "Inputs described by workflow_get.input_schema"}
                        },
                        "required": ["id_or_name"]
                    }
                },
                {
                    "name": "workflow_continue",
                    "description": "Resume a workflow paused on an agent action. Pass the run_id returned by workflow_run or the prior workflow_continue call and the completed action's structured result.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "run_id": {"type": "string", "description": "Workflow run UUID"},
                            "result": {"description": "Structured result matching action_required.expected_output"}
                        },
                        "required": ["run_id", "result"]
                    }
                },
                {
                    "name": "forecast_list",
                    "description": "List reusable usage forecast profiles. Reference these before planning or designing a project so user scale, budget, risk tolerance, growth, and usage shape inform decisions.",
                    "inputSchema": {"type": "object", "properties": {}}
                },
                {
                    "name": "forecast_create",
                    "description": "Create a reusable usage forecast profile for future project planning and design.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string"},
                            "description": {"type": "string"},
                            "application_type": {"type": "string", "enum": ["web_saas", "mobile", "ai", "data", "internal", "ecommerce", "other"]},
                            "user_count": {"type": "integer", "minimum": 1},
                            "monthly_budget_usd": {"type": "integer", "minimum": 0},
                            "stress_tolerance": {"type": "string", "enum": ["conservative", "balanced", "aggressive"], "description": "Conservative favors more headroom; aggressive favors lower cost and accepts operational pressure."},
                            "usage_pattern": {"type": "string", "enum": ["steady", "bursty", "seasonal"]},
                            "engagement_percent": {"type": "integer", "minimum": 1, "maximum": 100, "description": "Stickiness: % of monthly active users active on a typical day (e.g. 15 of 30 days = 50)."},
                            "planning_horizon_months": {"type": "integer", "minimum": 1, "maximum": 120},
                            "annual_growth_percent": {"type": "integer", "minimum": 0, "maximum": 1000},
                            "notes": {"type": "string"}
                        },
                        "required": ["name", "application_type", "user_count", "monthly_budget_usd", "stress_tolerance", "usage_pattern", "engagement_percent", "planning_horizon_months", "annual_growth_percent"]
                    }
                },
                {
                    "name": "forecast_update",
                    "description": "Update a forecast profile as assumptions change. Pass the complete profile fields.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "id": {"type": "string"},
                            "name": {"type": "string"}, "description": {"type": "string"},
                            "application_type": {"type": "string", "enum": ["web_saas", "mobile", "ai", "data", "internal", "ecommerce", "other"]},
                            "user_count": {"type": "integer"}, "monthly_budget_usd": {"type": "integer"},
                            "stress_tolerance": {"type": "string", "enum": ["conservative", "balanced", "aggressive"]},
                            "usage_pattern": {"type": "string", "enum": ["steady", "bursty", "seasonal"]},
                            "engagement_percent": {"type": "integer", "minimum": 1, "maximum": 100, "description": "Stickiness: % of monthly active users active on a typical day (e.g. 15 of 30 days = 50)."},
                            "planning_horizon_months": {"type": "integer"}, "annual_growth_percent": {"type": "integer"},
                            "notes": {"type": "string"}
                        },
                        "required": ["id", "name", "application_type", "user_count", "monthly_budget_usd", "stress_tolerance", "usage_pattern", "engagement_percent", "planning_horizon_months", "annual_growth_percent"]
                    }
                },
                {
                    "name": "forecast_delete",
                    "description": "Delete a reusable forecast profile permanently.",
                    "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]}
                },
                {
                    "name": "design_budget_list",
                    "description": "List saved monthly budget forecasts for a design, including AWS service line items and the usage profile or custom conditions used.",
                    "inputSchema": {"type": "object", "properties": {"design_id": {"type": "string"}}, "required": ["design_id"]}
                },
                {
                    "name": "design_budget_create",
                    "description": "Add a monthly budget forecast to a design. Use forecast_profile_id to base it on a saved Settings > Forecasts profile, conditions for custom assumptions, or both. monthly_total is derived from line_items.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "design_id": {"type": "string"}, "name": {"type": "string"},
                            "forecast_profile_id": {"type": "string"}, "conditions": {"type": "string"},
                            "currency": {"type": "string", "default": "USD"},
                            "line_items": {"type": "array", "items": {"type": "object", "properties": {
                                "service": {"type": "string"}, "usage": {"type": "string"},
                                "monthly_cost_cents": {"type": "integer", "minimum": 0}, "notes": {"type": "string"}
                            }, "required": ["service", "usage", "monthly_cost_cents"]}},
                            "confidence": {"type": "string", "enum": ["low", "medium", "high"]},
                            "pricing_basis": {"type": "string"}
                        },
                        "required": ["design_id", "name", "line_items"]
                    }
                },
                {
                    "name": "design_budget_update",
                    "description": "Replace a design budget forecast's assumptions and line items. monthly_total is recalculated from line_items.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "design_id": {"type": "string"}, "budget_id": {"type": "string"}, "name": {"type": "string"},
                            "forecast_profile_id": {"type": "string"}, "conditions": {"type": "string"}, "currency": {"type": "string"},
                            "line_items": {"type": "array", "items": {"type": "object", "properties": {
                                "service": {"type": "string"}, "usage": {"type": "string"},
                                "monthly_cost_cents": {"type": "integer", "minimum": 0}, "notes": {"type": "string"}
                            }, "required": ["service", "usage", "monthly_cost_cents"]}},
                            "confidence": {"type": "string", "enum": ["low", "medium", "high"]}, "pricing_basis": {"type": "string"}
                        },
                        "required": ["design_id", "budget_id", "name", "line_items"]
                    }
                },
                {
                    "name": "design_budget_delete",
                    "description": "Delete a saved design budget forecast permanently.",
                    "inputSchema": {"type": "object", "properties": {"design_id": {"type": "string"}, "budget_id": {"type": "string"}}, "required": ["design_id", "budget_id"]}
                },
                {
                    "name": "project_list",
                    "description": "List all projects with their task counts. Use this to find project_id for task operations.",
                    "inputSchema": {"type": "object", "properties": {}}
                },
                {
                    "name": "project_create",
                    "description": "Create a new project. Folder path is optional — omit it for a pure task-management project with no knowledge graph.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string", "description": "Display name for the project"},
                            "path": {"type": "string", "description": "Optional: absolute path to a folder to index for a knowledge graph"},
                            "description": {"type": "string", "description": "Optional description"}
                        },
                        "required": ["name"]
                    }
                },
                {
                    "name": "project_task_list",
                    "description": "List tasks for a project. Optionally filter by status (todo, in_progress, done, cancelled, scheduled).",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "project_id": {"type": "string", "description": "UUID of the project"},
                            "status": {"type": "string", "description": "Filter by status: todo | in_progress | done | cancelled | scheduled"},
                            "limit": {"type": "integer", "description": "Max results (default 50)"},
                            "offset": {"type": "integer", "description": "Pagination offset (default 0)"}
                        },
                        "required": ["project_id"]
                    }
                },
                {
                    "name": "project_task_create",
                    "description": "Create a task in a project. Can be used by AI agents to add work items.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "project_id": {"type": "string", "description": "UUID of the project"},
                            "title": {"type": "string", "description": "Task title"},
                            "description": {"type": "string", "description": "Optional detailed description"},
                            "status": {"type": "string", "description": "todo | in_progress | done | cancelled (default: todo)"},
                            "priority": {"type": "string", "description": "low | medium | high (default: medium)"},
                            "assigned_to": {"type": "string", "description": "human | agent | null"},
                            "parent_id": {"type": "string", "description": "Optional UUID of a parent task, to create this as a subtask"},
                            "start_date": {"type": "string", "description": "Optional start date, YYYY-MM-DD"},
                            "due_date": {"type": "string", "description": "Optional due date, YYYY-MM-DD"}
                        },
                        "required": ["project_id", "title"]
                    }
                },
                {
                    "name": "project_task_note_list",
                    "description": "List the append-only implementation notes, handoffs, and open/resolved decision checkpoints for a task.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "project_id": {"type": "string", "description": "UUID of the project"},
                            "task_id": {"type": "string", "description": "UUID of the task"},
                            "limit": {"type": "integer", "description": "Max notes to return (default 100)"}
                        },
                        "required": ["project_id", "task_id"]
                    }
                },
                {
                    "name": "project_task_note_create",
                    "description": "Add an implementation note, handoff message, or decision checkpoint to a task. Notes are append-only and attributed to the AI agent.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "project_id": {"type": "string", "description": "UUID of the project"},
                            "task_id": {"type": "string", "description": "UUID of the task"},
                            "content": {"type": "string", "description": "Implementation detail, decision question, finding, or handoff message"},
                            "note_type": {"type": "string", "description": "message (default) or decision"},
                            "decision_options": {"type": "array", "items": {"type": "string"}, "description": "Two to six choices when note_type is decision (for example [\"Yes\", \"No\"] )"}
                        },
                        "required": ["project_id", "task_id", "content"]
                    }
                },
                {
                    "name": "project_task_note_decide",
                    "description": "Answer a task decision checkpoint by selecting one or more of its choices. Calling this again on the same decision records a new answer (with the previous answer kept in history) rather than failing.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "project_id": {"type": "string", "description": "UUID of the project"},
                            "task_id": {"type": "string", "description": "UUID of the task"},
                            "note_id": {"type": "string", "description": "UUID of the decision note"},
                            "options": {"type": "array", "items": {"type": "string"}, "description": "One or more exact choices to select"},
                            "author": {"type": "string", "description": "human or agent (default: agent)"}
                        },
                        "required": ["project_id", "task_id", "note_id", "options"]
                    }
                },
                {
                    "name": "project_task_update",
                    "description": "Update a task's title, description, status, priority, assigned_to, parent, or dates. Only provided fields are changed; pass null for parent_id/start_date/due_date to clear them. Use status 'cancelled' (not 'done') for tasks that are being dropped/superseded rather than completed.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "project_id": {"type": "string"},
                            "task_id": {"type": "string"},
                            "title": {"type": "string"},
                            "description": {"type": "string"},
                            "status": {"type": "string", "description": "todo | in_progress | done | cancelled"},
                            "priority": {"type": "string", "description": "low | medium | high"},
                            "assigned_to": {"type": "string", "description": "human | agent | null"},
                            "parent_id": {"type": ["string", "null"], "description": "UUID of a parent task, or null to detach this task from its parent"},
                            "start_date": {"type": ["string", "null"], "description": "Start date YYYY-MM-DD, or null to clear"},
                            "due_date": {"type": ["string", "null"], "description": "Due date YYYY-MM-DD, or null to clear"}
                        },
                        "required": ["project_id", "task_id"]
                    }
                },
                {
                    "name": "project_task_delete",
                    "description": "Delete a task permanently.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "project_id": {"type": "string"},
                            "task_id": {"type": "string"}
                        },
                        "required": ["project_id", "task_id"]
                    }
                },
                {
                    "name": "lesson_create",
                    "description": "Record a lesson learned in a project's lessons store. If an active lesson with the same title already exists in this project, its occurrence count is bumped instead of creating a duplicate.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "project_id": {"type": "string", "description": "UUID of the project"},
                            "title": {"type": "string", "description": "Short lesson title"},
                            "rule": {"type": "string", "description": "The rule to follow going forward"},
                            "context": {"type": "string", "description": "What happened that produced this lesson"},
                            "category": {"type": "string", "description": "correction | discovery | convention | pitfall (default: correction)"},
                            "severity": {"type": "string", "description": "low | medium | high (default: medium)"},
                            "tags": {"type": "array", "items": {"type": "string"}, "description": "Optional free-text tags"}
                        },
                        "required": ["project_id", "title", "rule"]
                    }
                },
                {
                    "name": "lesson_list",
                    "description": "Call this at the start of a session to load the project's accumulated lessons. project_id is optional — omit it to search across all projects. Pass query to full-text search; otherwise lessons are ranked by severity then recency.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "project_id": {"type": "string", "description": "UUID of the project. Omit for a cross-project search."},
                            "query": {"type": "string", "description": "Full-text search across title, context, and rule"},
                            "category": {"type": "string", "description": "Filter by category: correction | discovery | convention | pitfall"},
                            "tags": {"type": "array", "items": {"type": "string"}, "description": "Filter to lessons matching any of these tags"},
                            "status": {"type": "string", "description": "active | archived (default: active)"},
                            "limit": {"type": "integer", "description": "Max results (default 50)"},
                            "offset": {"type": "integer", "description": "Pagination offset (default 0)"}
                        }
                    }
                },
                {
                    "name": "lesson_update",
                    "description": "Update a lesson's title, context, rule, category, severity, status, or tags. Only provided fields are changed; pass null for context to clear it. Set status to 'archived' when a lesson is superseded rather than deleting it.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "project_id": {"type": "string"},
                            "lesson_id": {"type": "string"},
                            "title": {"type": "string"},
                            "context": {"type": ["string", "null"], "description": "New context, or null to clear"},
                            "rule": {"type": "string"},
                            "category": {"type": "string", "description": "correction | discovery | convention | pitfall"},
                            "severity": {"type": "string", "description": "low | medium | high"},
                            "status": {"type": "string", "description": "active | archived"},
                            "tags": {"type": "array", "items": {"type": "string"}}
                        },
                        "required": ["project_id", "lesson_id"]
                    }
                },
                {
                    "name": "lesson_delete",
                    "description": "Delete a lesson permanently.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "project_id": {"type": "string"},
                            "lesson_id": {"type": "string"}
                        },
                        "required": ["project_id", "lesson_id"]
                    }
                },
                {
                    "name": "routine_check",
                    "description": "Check for due routine tasks and create them as new todo items. Call this at the start of a work session to materialise any daily/weekly/monthly tasks that haven't been created yet today. Returns the list of tasks just created. Use dry_run=true to preview without creating.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "project_id": {"type": "string", "description": "Check routines for this project only. Omit to check all projects."},
                            "dry_run": {"type": "boolean", "description": "If true, return due routines without creating tasks (default false)"}
                        }
                    }
                },
                {
                    "name": "routine_list",
                    "description": "List all routines for a project, including their frequency and last-run date.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "project_id": {"type": "string", "description": "UUID of the project"}
                        },
                        "required": ["project_id"]
                    }
                },
                {
                    "name": "routine_create",
                    "description": "Create a new routine task template. The routine will generate a dated task each time routine_check is called and the routine is due.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "project_id": {"type": "string"},
                            "title": {"type": "string", "description": "Base title — today's date is appended when the task is created"},
                            "description": {"type": "string", "description": "Optional task description or instructions for the agent"},
                            "frequency": {"type": "string", "description": "daily | weekly | monthly (default: daily)"},
                            "priority": {"type": "string", "description": "low | medium | high (default: medium)"},
                            "assigned_to": {"type": "string", "description": "human | agent | null"}
                        },
                        "required": ["project_id", "title"]
                    }
                }
            ]
        }))
    }
}
