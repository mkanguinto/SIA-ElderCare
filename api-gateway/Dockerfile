FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund; else npm install --omit=dev --no-audit --no-fund; fi && npm cache clean --force
COPY . .
# Token store (revoked tokens, refresh sessions) lives on the gateway-state volume
RUN mkdir -p /app/state && chown node:node /app/state
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:${PORT:-8080}/health || exit 1
CMD ["node", "server.js"]
