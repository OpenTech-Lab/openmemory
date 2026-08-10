# ── Stage 1: build ──────────────────────────────────────────────────────────
FROM rust:1-slim-bookworm AS builder

RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY . .

RUN cargo build --release --bin openmemory-server

# ── Stage 2: runtime ────────────────────────────────────────────────────────
FROM debian:bookworm-slim

# ca-certificates for rustls root cert validation; curl for healthcheck;
# git for the project-graph indexer's commit-history collection
RUN apt-get update \
    && apt-get install -y ca-certificates curl git \
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

# /data/design-blobs backs a named Docker volume (see docker-compose.yml) that
# Docker auto-creates as root:root, mode 0755, on first mount — unwritable by
# any non-root container user. docker-compose.yml overrides this image's
# baked-in USER (10001:10001) with `user: "${UID:-1000}:${GID:-1000}"`, i.e.
# the *host* user's UID:GID, which is not known at image build time and varies
# per machine. Since we can't chown to a UID we don't know, make the directory
# world-writable instead so it's writable under either the baked-in USER or
# whatever UID:GID docker-compose substitutes at runtime.
RUN mkdir -p /data/design-blobs && chmod 0777 /data/design-blobs

USER 10001:10001
CMD ["openmemory-server"]
