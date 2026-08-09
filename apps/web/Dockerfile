FROM node:20-alpine AS builder
WORKDIR /app
ARG NEXT_PUBLIC_DRAWIO_EDITOR_URL=http://localhost:18081
ARG NEXT_PUBLIC_DRAWIO_VIEWER_URL=http://localhost:18081
ENV NEXT_PUBLIC_DRAWIO_EDITOR_URL=$NEXT_PUBLIC_DRAWIO_EDITOR_URL
ENV NEXT_PUBLIC_DRAWIO_VIEWER_URL=$NEXT_PUBLIC_DRAWIO_VIEWER_URL
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
