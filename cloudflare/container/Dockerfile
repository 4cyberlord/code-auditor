FROM node:24-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund

COPY scripts ./scripts
COPY src ./src

ENV PORT=8787
EXPOSE 8787
CMD ["node", "scripts/worker-server.mjs"]
