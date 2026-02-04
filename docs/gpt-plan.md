# 🧠 OpenMemory — Local AI Memory System via MCP

A lightweight, local, shared memory system for multiple AI tools and agents.

**OpenMemory** provides persistent, searchable, and controllable memory for AIs by running a local MCP server backed by PostgreSQL + OpenSearch.

Instead of heavy RAG pipelines that waste tokens and compute, this system focuses on:

> ⚡ Fast keyword/importance-based retrieval
> 💾 Structured + semantic memory
> 🔌 MCP-native integration
> 🏠 Fully local & privacy-first
> 🐳 Docker-ready

---

## ✨ Why OpenMemory?

Most AI tools:

* forget everything
* or use full RAG (slow + expensive)
* or send entire chat history (token waste)

### Problems with traditional RAG

| Issue                       | Result        |
| --------------------------- | ------------- |
| Vector search every message | slow          |
| Embed everything            | expensive     |
| Send large contexts         | token waste   |
| Hard to control recall      | noisy answers |

---

## 💡 Our Approach

We **do NOT use full RAG**.

Instead we use:

### 🔹 Hybrid Memory Retrieval

1. **Keyword / importance indexing**
2. **BM25 lexical search**
3. **Optional vector similarity**
4. **Extract only exact message blocks**
5. **Return minimal context**

Result:

> Small, precise, fast memory recall

---

# 🏗 Architecture

```
┌────────────────────────────┐
│  AI Tool (Claude/GPT/etc)  │
│        via MCP client      │
└──────────────┬─────────────┘
               │ MCP
┌──────────────▼─────────────┐
│       OpenMemory MCP       │
│        (Rust server)       │
├──────────────┬─────────────┤
│ PostgreSQL   │ OpenSearch  │
│ structured   │ search idx  │
└──────────────┴─────────────┘
               │
        Next.js Dashboard
```

---

# 🧩 Features

### Core

* Persistent AI memory
* MCP server
* Local-first (no cloud required)
* Multi-AI shared memory
* Switchable recall (on/off)

### Memory Types

* Conversations
* Notes
* Facts
* Summaries
* Tool outputs

### Retrieval

* keyword index (BM25)
* importance score
* optional embeddings
* fast extraction
* minimal token usage

### Dev Experience

* Monorepo (Turborepo)
* Docker Compose
* One command startup

---

# 🛠 Tech Stack

## Backend

* Rust (Axum)
* PostgreSQL
* OpenSearch
* MCP protocol

## Frontend

* Next.js (App Router)
* TailwindCSS
* shadcn/ui

## Infra

* Docker Compose
* Turborepo
* pnpm

---

# 📂 Project Structure (Monorepo)

```
openmemory/
│
├─ apps/
│   ├─ web/           # Next.js dashboard
│   └─ server/        # Rust MCP server
│
├─ packages/
│   ├─ sdk/           # TS SDK for clients
│   └─ shared-types/
│
├─ docker/
│
├─ turbo.json
├─ docker-compose.yml
└─ README.md
```

---

# 🚀 Quick Start

## 1. Clone

```bash
git clone https://github.com/yourname/openmemory
cd openmemory
```

---

## 2. Start with Docker

```bash
docker compose up
```

Starts:

* postgres
* opensearch
* rust server
* nextjs dashboard

---

## 3. Open dashboard

```
http://localhost:3000
```

---

## 4. Add MCP server to your AI tool

Example:

```json
{
  "mcpServers": {
    "memory": {
      "command": "openmemory-server",
      "args": ["--port", "8080"]
    }
  }
}
```

---

# 🔌 Usage Flow

### Typical interaction

```
User → AI Tool → MCP → OpenMemory
                    ↓
               search memories
                    ↓
              return top context
                    ↓
              AI generates answer
                    ↓
             save conversation
```

---

## Memory Switch

Users can toggle:

```
Memory: ON  → recall + store
Memory: OFF → ignore memory
```

Useful for:

* private chats
* temporary sessions
* testing

---

# 🧠 Memory Algorithm Design

## Goals

* fast (<10ms search)
* low token usage
* minimal embeddings
* high precision

---

## Storage Model

### PostgreSQL

```
memories
- id
- user_id
- content
- summary
- importance_score
- tags
- created_at
```

### OpenSearch index

```
content (BM25)
keywords
summary
tags
importance_score
```

---

# 🔍 Retrieval Strategy (NOT pure RAG)

## Step 1 — Extract keywords

Use:

* TF-IDF
* RAKE
* KeyBERT
* or simple noun phrase extraction

Example:

```
"how to deploy docker on ubuntu"
→ ["docker", "deploy", "ubuntu"]
```

---

## Step 2 — Hybrid search

```
score =
  BM25 * 0.6
+ importance * 0.2
+ recency * 0.1
+ optional vector * 0.1
```

---

## Step 3 — Select only top blocks

Instead of full documents:

```
top 3–5 message chunks only
```

---

## Step 4 — Inject minimal context

```
<Memory>
• previous docker fix
• ubuntu install steps
</Memory>
```

---

# ⚡ Why this beats RAG

| Method       | Cost   | Speed  | Tokens    |
| ------------ | ------ | ------ | --------- |
| Full RAG     | high   | slow   | high      |
| Chat history | medium | medium | very high |
| OpenMemory   | low    | fast   | low       |

---

# 🧪 Development

## Install deps

```bash
pnpm install
```

---

## Run everything

```bash
pnpm dev
```

(Turborepo runs server + web)

---

## Individual

### Web

```bash
pnpm --filter web dev
```

### Server

```bash
cargo run
```

---

# 🧠 MCP API Example

### Save memory

```json
{
  "type": "memory.save",
  "content": "User prefers docker compose for deployments",
  "importance": 0.9
}
```

### Search memory

```json
{
  "type": "memory.search",
  "query": "docker deployment setup"
}
```

---

# 🔐 Privacy

* fully local
* no cloud
* no telemetry
* your data stays yours

---

# 📈 Roadmap

### v1

* MCP server
* search
* dashboard
* docker

### v2

* semantic embeddings
* auto summarization
* memory clustering
* tagging

### v3

* multi-device sync
* plugin system
* agent tools

---

# 🧩 Future Research Ideas

You may explore:

* Hybrid search (BM25 + vector)
* Importance scoring (Ebbinghaus forgetting curve)
* Memory decay
* Hierarchical memory (short/long term)
* LLM-based summarization
* Knowledge graph linking

References:

* Retrieval Augmented Generation
* BM25 ranking
* KeyBERT
* Memory consolidation (cognitive science)

---

# 🤝 Contributing

PRs welcome!

```bash
pnpm build
pnpm lint
pnpm test
```

---

# 📜 License

MIT

