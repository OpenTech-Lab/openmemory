# openmemory-server

Minimal Rust (Axum) server that accepts MCP-style JSON requests at `POST /mcp`.

## Endpoints

- `GET /health`
- `POST /mcp`
  - `{"type":"memory.save", ...}`
  - `{"type":"memory.search", ...}`

## Run

```bash
cargo run -p openmemory-server
```

By default it binds `127.0.0.1:8080`. Override with `OPENMEMORY_PORT`.
