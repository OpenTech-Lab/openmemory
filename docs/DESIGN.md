# OpenMemory Design Document

A lightweight, local, shared memory system for AI tools and agents via MCP (Model Context Protocol).

## Table of Contents

- [Overview](#overview)
- [Approach](#approach)
- [Architecture](#architecture)
- [Data Model](#data-model)
- [Workflow](#workflow)
- [API Reference](#api-reference)
- [Comparison](#comparison)

---

## Overview

OpenMemory provides persistent, searchable, and controllable memory for AI assistants. Unlike traditional RAG systems that embed everything and perform expensive vector searches, OpenMemory uses a lightweight hybrid retrieval approach.

### Design Principles

| Principle | Description |
|-----------|-------------|
| **Local-first** | All data stays on your machine, no cloud dependencies |
| **Token-efficient** | Minimal context injection, only relevant memories |
| **Fast retrieval** | Target < 10ms search latency |
| **MCP-native** | Standard protocol for AI tool integration |
| **Privacy-first** | No telemetry, no external calls |

---

## Approach

### Why NOT Full RAG?

```mermaid
flowchart LR
    subgraph Traditional RAG
        A[User Query] --> B[Embed Query]
        B --> C[Vector Search]
        C --> D[Retrieve Documents]
        D --> E[Send Large Context]
        E --> F[LLM Response]
    end

    style B fill:#ff6b6b,color:#fff
    style C fill:#ff6b6b,color:#fff
    style E fill:#ff6b6b,color:#fff
```

**Problems with traditional RAG:**

| Issue | Impact |
|-------|--------|
| Embed every query | Expensive API calls |
| Vector search | Slow (~100ms+) |
| Large context windows | Token waste |
| Semantic-only matching | Misses keyword relevance |

### Our Hybrid Approach

```mermaid
flowchart LR
    subgraph OpenMemory
        A[User Query] --> B[Extract Keywords]
        B --> C[BM25 + Importance Search]
        C --> D[Top 3-5 Results]
        D --> E[Minimal Context]
        E --> F[LLM Response]
    end

    style B fill:#51cf66,color:#fff
    style C fill:#51cf66,color:#fff
    style E fill:#51cf66,color:#fff
```

**Hybrid Memory Retrieval:**

1. **Keyword extraction** - Extract key terms from query
2. **BM25 lexical search** - Fast full-text search via OpenSearch
3. **Importance scoring** - User-defined priority weights
4. **Recency boost** - Recent memories rank higher
5. **Minimal extraction** - Return only relevant chunks

### Scoring Formula

```
final_score = importance * 0.6 + recency * 0.4
```

Where:
- `importance`: User-assigned score (0.0 - 1.0)
- `recency`: Exponential decay based on age (e^(-days/30))

---

## Architecture

### System Overview

```mermaid
flowchart TB
    subgraph Clients["AI Clients"]
        Claude[Claude Code]
        GPT[ChatGPT]
        Other[Other AI Tools]
    end

    subgraph MCP["MCP Layer"]
        Server[OpenMemory MCP Server<br/>Rust / Axum]
    end

    subgraph Storage["Storage Layer"]
        PG[(PostgreSQL<br/>Index & Metadata)]
        OS[(OpenSearch<br/>Full-text Search)]
    end

    subgraph UI["Dashboard"]
        Web[Next.js Dashboard]
    end

    Claude -->|MCP Protocol| Server
    GPT -->|MCP Protocol| Server
    Other -->|MCP Protocol| Server

    Server -->|Index Data| PG
    Server -->|Search & Content| OS

    Web -->|REST API| Server
    Web -->|Direct Query| PG
```

### Component Details

```mermaid
flowchart LR
    subgraph MCP Server
        direction TB
        Handler[Request Handler]
        Tools[Tool Registry]
        Save[memory_save]
        Search[memory_search]

        Handler --> Tools
        Tools --> Save
        Tools --> Search
    end

    subgraph PostgreSQL
        direction TB
        Index[memory_index table]
        Meta[Metadata & Tags]
    end

    subgraph OpenSearch
        direction TB
        Content[Content Index]
        BM25[BM25 Scoring]
    end

    Save --> Index
    Save --> Content
    Search --> BM25
    Search --> Index
```

### Tech Stack

| Layer | Technology | Purpose |
|-------|------------|---------|
| **MCP Server** | Rust + Axum | High-performance async server |
| **Metadata Store** | PostgreSQL | Structured data, importance scores, tags |
| **Search Engine** | OpenSearch | BM25 full-text search |
| **Dashboard** | Next.js + shadcn/ui | Memory management UI |
| **Infrastructure** | Docker Compose | One-command deployment |

---

## Data Model

A single memory is split across two stores for optimal performance:

```mermaid
erDiagram
    MEMORY ||--|| MEMORY_INDEX : "metadata in"
    MEMORY ||--|| MEMORY_DOCUMENT : "content in"

    MEMORY {
        uuid id PK "Shared identifier"
    }

    MEMORY_INDEX {
        uuid id PK "PostgreSQL"
        text user_id
        text summary
        real importance_score "0.0 - 1.0"
        text_array tags
        timestamptz created_at
        timestamptz updated_at
    }

    MEMORY_DOCUMENT {
        string id PK "OpenSearch"
        string user_id
        string content "Full text (BM25 indexed)"
        string summary
        float importance_score
        string_array tags "Keyword indexed"
        datetime created_at
        datetime updated_at
    }
```

| Store | Purpose | Data |
|-------|---------|------|
| **PostgreSQL** | Fast metadata lookup | id, importance, tags, timestamps |
| **OpenSearch** | Full-text search (BM25) | content, summary, tags |

### Data Flow

```mermaid
sequenceDiagram
    participant Client as AI Client
    participant MCP as MCP Server
    participant PG as PostgreSQL
    participant OS as OpenSearch

    Note over Client,OS: Save Memory
    Client->>MCP: memory_save(content, importance, tags)
    MCP->>PG: INSERT memory_index
    MCP->>OS: Index document
    MCP-->>Client: {id, status: "saved"}

    Note over Client,OS: Search Memory
    Client->>MCP: memory_search(query, limit)
    MCP->>OS: BM25 search
    OS-->>MCP: Matching documents
    MCP->>PG: Get importance scores
    PG-->>MCP: Index data
    MCP->>MCP: Compute combined scores
    MCP-->>Client: Top N results
```

---

## Workflow

### Memory Save Flow

```mermaid
flowchart TD
    A[AI detects important info] --> B{Worth remembering?}
    B -->|Yes| C[Call memory_save]
    B -->|No| End[Continue]

    C --> D[Assign importance 0.0-1.0]
    D --> E[Add relevant tags]
    E --> F[Generate summary]
    F --> G[Save to PostgreSQL]
    G --> H[Index in OpenSearch]
    H --> I[Return memory ID]

    style C fill:#228be6,color:#fff
    style G fill:#40c057,color:#fff
    style H fill:#fab005,color:#fff
```

### Memory Search Flow

```mermaid
flowchart TD
    A[User asks question] --> B[AI needs context]
    B --> C[Call memory_search]

    C --> D[OpenSearch BM25 query]
    D --> E[Get candidate documents]
    E --> F[Fetch importance from PostgreSQL]
    F --> G[Calculate combined score]
    G --> H[Sort by score]
    H --> I[Return top N results]

    I --> J[AI uses context]
    J --> K[Generate response]

    style D fill:#fab005,color:#fff
    style F fill:#40c057,color:#fff
    style G fill:#228be6,color:#fff
```

### Typical Conversation Flow

```mermaid
sequenceDiagram
    actor User
    participant AI as AI Assistant
    participant Mem as OpenMemory

    User->>AI: Ask question about Docker

    AI->>Mem: memory_search("Docker")
    Mem-->>AI: Previous Docker preferences & notes

    AI->>User: Response with personalized context

    User->>AI: Thanks, I'll use docker compose

    AI->>Mem: memory_save("User prefers docker compose", importance=0.8)
    Mem-->>AI: Saved

    AI->>User: Got it, I'll remember that!
```

### Memory Toggle States

```mermaid
stateDiagram-v2
    [*] --> MemoryON

    MemoryON: Memory Enabled
    MemoryON: - Search on queries
    MemoryON: - Save important info

    MemoryOFF: Memory Disabled
    MemoryOFF: - No search
    MemoryOFF: - No saving

    MemoryON --> MemoryOFF: User toggles off
    MemoryOFF --> MemoryON: User toggles on

    note right of MemoryOFF: Use for private chats
```

---

## API Reference

### MCP Tools

#### memory_save

Save information to memory for later recall.

```json
{
  "name": "memory_save",
  "arguments": {
    "content": "User prefers TypeScript over JavaScript",
    "summary": "TypeScript preference",
    "importance": 0.8,
    "tags": ["preference", "coding"]
  }
}
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `content` | string | Yes | The information to remember |
| `summary` | string | No | Brief summary for quick reference |
| `importance` | number | No | Priority score 0.0-1.0 (default: 0.5) |
| `tags` | string[] | No | Categorization tags |

#### memory_search

Search memories by keywords.

```json
{
  "name": "memory_search",
  "arguments": {
    "query": "TypeScript preferences",
    "limit": 5
  }
}
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search keywords |
| `limit` | number | No | Max results (default: 5, max: 20) |

### Importance Score Guidelines

| Score | Use Case |
|-------|----------|
| 0.9 - 1.0 | Critical preferences, key decisions |
| 0.7 - 0.8 | Important context, project configs |
| 0.5 - 0.6 | General useful information |
| 0.3 - 0.4 | Nice to know, minor details |
| 0.1 - 0.2 | Ephemeral context |

---

## Comparison

### OpenMemory vs Alternatives

```mermaid
quadrantChart
    title Speed vs Cost Trade-off
    x-axis Low Cost --> High Cost
    y-axis Slow --> Fast
    quadrant-1 Ideal
    quadrant-2 Fast and Cheap
    quadrant-3 Slow and Cheap
    quadrant-4 Worst
    OpenMemory: [0.2, 0.85]
    Full RAG: [0.8, 0.3]
    Chat History: [0.5, 0.5]
    No Memory: [0.1, 0.9]
```

| Method | Cost | Speed | Tokens | Precision |
|--------|------|-------|--------|-----------|
| **OpenMemory** | Low | Fast (<10ms) | Low | High |
| Full RAG | High | Slow (~100ms) | High | Medium |
| Chat History | Medium | Medium | Very High | Low |
| No Memory | None | Instant | None | N/A |

---

## Project Structure

```
openmemory/
├── apps/
│   ├── web/              # Next.js dashboard
│   └── server/           # Rust MCP server
│       └── src/
│           └── mcp.rs    # Core MCP implementation
├── packages/
│   ├── sdk/              # TypeScript SDK
│   └── shared-types/     # Shared type definitions
├── scripts/
│   └── seed-data.py      # Demo data seeder
├── docs/
│   ├── DESIGN.md         # This document
│   └── plan/             # Planning documents
├── docker-compose.yml
└── turbo.json
```

---

## Future Considerations

```mermaid
timeline
    title Roadmap
    section v1 (Current)
        MCP Server : Basic save/search
        Dashboard : View memories
        Docker : One-command setup
    section v2
        Auto-summarization : LLM-powered summaries
        Memory clustering : Group related memories
        Better tagging : Auto-tag suggestions
    section v3
        Multi-device sync : Sync across machines
        Plugin system : Extensible architecture
        Agent tools : Advanced AI workflows
```

---

## References

- [Model Context Protocol (MCP)](https://modelcontextprotocol.io/)
- [BM25 Algorithm](https://en.wikipedia.org/wiki/Okapi_BM25)
- [OpenSearch Documentation](https://opensearch.org/docs/latest/)
- [Retrieval-Augmented Generation](https://arxiv.org/abs/2005.11401)
