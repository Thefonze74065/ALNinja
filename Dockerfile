# --- Build the web UI ---
FROM node:24-slim AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# --- Runtime: Node runs the TypeScript server directly (type stripping + built-in SQLite) ---
FROM node:24-slim
# Set by CI to the commit being built; logged at startup and reported by /api/status.
ARG ALNINJA_VERSION=dev
ENV ALNINJA_VERSION=$ALNINJA_VERSION \
    NODE_ENV=production \
    DATA_DIR=/data \
    WEB_DIR=/app/web/dist \
    PORT=8080 \
    NODE_NO_WARNINGS=1
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server/ ./server/
COPY --from=web /app/web/dist ./web/dist
RUN mkdir -p /data && chown node:node /data

VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
USER node
CMD ["node", "server/src/index.ts"]
