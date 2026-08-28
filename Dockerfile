# Production image for the Discord music bot.
# Use with: docker run --env-file .env --restart unless-stopped discord-music-bot
# Do not also run PM2 inside this container.

FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
  && npm cache clean --force \
  && rm -rf node_modules/ffmpeg-static

COPY src ./src
RUN mkdir -p /app/logs && chown -R node:node /app

ENV NODE_ENV=production
USER node

CMD ["node", "src/index.js"]
