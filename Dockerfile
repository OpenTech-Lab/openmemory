# ── Stage 1: build ──────────────────────────────────────────────────────────
FROM rust:1-slim-bookworm AS builder

RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY . .

RUN cargo build --release --bin openmemory-server

# ── Stage 2: runtime ────────────────────────────────────────────────────────
FROM debian:bookworm-slim

# ca-certificates for rustls root cert validation; curl for healthcheck
RUN apt-get update \
    && apt-get install -y ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /build/target/release/openmemory-server /usr/local/bin/openmemory-server

ENV OPENMEMORY_PORT=8080
ENV OPENMEMORY_HOST=0.0.0.0
ENV DATABASE_URL=postgres://openmemory:openmemory@postgres:5432/openmemory
ENV OPENSEARCH_URL=http://opensearch:9200
ENV REDIS_URL=redis://redis:6379
ENV FALKORDB_URL=redis://falkordb:6379

EXPOSE 8080

CMD ["openmemory-server"]
