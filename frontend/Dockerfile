FROM node:20-alpine AS builder
WORKDIR /app

# NEXT_PUBLIC_* vars must be present at build time — with output:standalone
# they're inlined into the client bundle AND baked into next.config.mjs's
# rewrites() (the /api/* proxy the seven standalone module pages depend
# on), which is resolved once at build time for a standalone server, not
# re-evaluated per request. Setting these only at `docker run`/container
# start (as plain ENV, after the image is built) is too late — confirmed
# directly: a standalone build without these ARGs produces a working
# server that 500s on every /api/* request, because the rewrite destination
# was frozen as "undefined" during the build.
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_ENABLE_STIR
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_ENABLE_STIR=$NEXT_PUBLIC_ENABLE_STIR

COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

EXPOSE 3000
CMD ["node", "server.js"]
