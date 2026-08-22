# Production image for the Discord music bot.
# Use with: docker run --env-file .env --restart unless-stopped discord-music-bot
# Do not also run PM2 inside this container.

FROM node:20.16.0-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
RUN mkdir -p /app/logs && chown -R node:node /app

ENV NODE_ENV=production
USER node

CMD ["node", "src/index.js"]
