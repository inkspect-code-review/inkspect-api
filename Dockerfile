FROM node:26-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY vendor ./vendor
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build
FROM node:26-bookworm-slim
RUN apt-get update -qq && apt-get install -y --no-install-recommends ca-certificates git && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production API_HOST=0.0.0.0 PORT=3003
COPY --from=build --chown=node:node /app /app
RUN mkdir -p /state && chown node:node /state
USER node
CMD ["node","dist/server.mjs"]
