# Phantom — production image.
#
# One image serves both roles: `npm start` runs the web app, `npm run worker`
# runs the background processor. Same code, same dependencies, different
# entrypoint — which keeps the two from drifting apart.

FROM node:22-bookworm-slim AS base
# ffmpeg is the render engine; fonts are needed for burned-in captions.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg \
      fonts-inter \
      fonts-dejavu-core \
      openssl \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# --- Dependencies -----------------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm ci --ignore-scripts && npx prisma generate

# --- Build ------------------------------------------------------------------
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npm run build

# --- Runtime ----------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
ENV LOG_FORMAT=json

# Run unprivileged. Media processing executes ffmpeg on user-supplied files,
# so the process should hold as little authority as possible.
RUN groupadd --system --gid 1001 phantom \
 && useradd --system --uid 1001 --gid phantom phantom

COPY --from=deps  --chown=phantom:phantom /app/node_modules ./node_modules
COPY --from=build --chown=phantom:phantom /app/.next       ./.next
COPY --from=build --chown=phantom:phantom /app/public      ./public
COPY --from=build --chown=phantom:phantom /app/prisma      ./prisma
COPY --from=build --chown=phantom:phantom /app/src         ./src
COPY --from=build --chown=phantom:phantom /app/package.json /app/next.config.ts /app/tsconfig.json ./

RUN mkdir -p /app/storage /app/tmp && chown -R phantom:phantom /app/storage /app/tmp

USER phantom
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
