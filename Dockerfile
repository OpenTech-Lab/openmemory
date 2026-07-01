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

# Run as non-root user
RUN groupadd --system --gid 10001 app \
    && useradd --system --uid 10001 --gid app --no-create-home --shell /usr/sbin/nologin app

COPY --from=builder /build/target/release/openmemory-server /usr/local/bin/openmemory-server

# Port and host defaults only — connection strings must be supplied at runtime
# (see docker-compose.yml or pass -e DATABASE_URL=... etc.)
ENV OPENMEMORY_PORT=18080
ENV OPENMEMORY_HOST=0.0.0.0

EXPOSE 18080

USER 10001:10001
CMD ["openmemory-server"]
