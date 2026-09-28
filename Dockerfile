FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .

ENV NODE_ENV=production \
    PORT=3000 \
    STORAGE_DIR=/data
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "src/server.js"]
