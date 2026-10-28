# anime bench — one small node container, no build step, no database.
# works on any free docker host (render, koyeb, fly, hugging face, a $0 vps).
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0

WORKDIR /app

# deps first so rebuilds are fast
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

COPY server ./server
COPY web ./web

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s \
  CMD wget -qO- "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 || exit 1

USER node

CMD ["node", "server/index.js"]
