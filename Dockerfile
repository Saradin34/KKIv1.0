# =====================================================================
#  Эхо-Цитадель — multi-stage образы (LAUNCH план: Docker Compose-прод)
#    runtime-proto  — веб-прототип (tools/serve.js, без node_modules)
#    runtime-meta   — meta-server  :8081 (profiles/auth/telemetry, bundle)
#    runtime-match  — матч-сервер  :8080 (ws, bundle)
#  Сборка:
#    docker build -t echo-citadel .                          # proto (обратная совместимость)
#    docker build --target runtime-meta  -t echo-meta .
#    docker build --target runtime-match -t echo-match .
# =====================================================================

# ---------- общая сборка: прототип + серверные бандлы ----------
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm i --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY tools ./tools
COPY server ./server
COPY unity ./unity
RUN npm run build:proto \
 && npx esbuild server/meta_server.ts  --bundle --platform=node --format=cjs --external:pg-native --outfile=build/meta_server.js  --log-level=error \
 && npx esbuild server/match_server.ts --bundle --platform=node --format=cjs --outfile=build/match_server.js --log-level=error

# ---------- meta-server ----------
FROM node:20-alpine AS runtime-meta
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/build/meta_server.js ./build/meta_server.js
RUN mkdir -p /app/server/data
EXPOSE 8081
# volume с metadata (snapshot.json + accounts.json) монтируется на /app/server/data
CMD ["node", "build/meta_server.js"]

# ---------- матч-сервер (ws) ----------
FROM node:20-alpine AS runtime-match
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/build/match_server.js ./build/match_server.js
EXPOSE 8080
CMD ["node", "build/match_server.js"]

# ---------- веб-прототип (дефолтная цель: `docker build .`) ----------
FROM node:20-alpine AS runtime-proto
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
COPY tools/serve.js ./tools/serve.js
COPY --from=build /app/prototype ./prototype
# арты художника и drop-зона: маршруты /art и /heroes работают в проде
COPY art_raw ./art_raw
COPY unity ./unity
EXPOSE 5173
# 0.0.0.0 — обязательно для PaaS/Cloud Run (health-check и внешний трафик)
CMD ["node", "tools/serve.js", "--port", "5173"]
