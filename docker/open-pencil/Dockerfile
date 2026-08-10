# Builds the OpenPencil embed from a checkout mounted at build time. Unlike the draw.io
# service, which serves a prebuilt static webapp directly, OpenPencil is a Vite + WASM
# app and must be compiled. Network is required here at BUILD time only; the resulting
# image serves entirely offline.
FROM oven/bun:1.3.10 AS build
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
# OPENMEMORY_WEB_ORIGIN is the embed's postMessage trust anchor: it must be baked into
# the JS bundle at `vite build` time via a Vite `define`, not read at container runtime.
# A bare ARG is not visible to the build process — it must be re-exported as ENV first.
ARG OPENMEMORY_WEB_ORIGIN
ENV OPENMEMORY_WEB_ORIGIN=$OPENMEMORY_WEB_ORIGIN
RUN bun run build:packages && bunx vite build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
# nginx.conf is bind-mounted by docker-compose.yml at runtime, not COPYed here: the
# build context for this stage is the OpenPencil checkout (see OPEN_PENCIL_PATH), which
# does not contain this repo's docker/open-pencil/nginx.conf, so a COPY here cannot
# resolve it.
