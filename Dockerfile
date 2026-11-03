# Haat gateway. No runtime dependencies, so no npm install: Node runs the TypeScript directly.
# Pin the base image by digest for production builds (docker buildx imagetools inspect node:22-alpine).
FROM node:22-alpine

ENV NODE_ENV=production \
    HAAT_HOST=0.0.0.0 \
    HAAT_PORT=8080 \
    HAAT_DB=/data/haat.db \
    HAAT_NETWORK=mock

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY packs ./packs
COPY mock-network ./mock-network

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HAAT_PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/main.ts"]
