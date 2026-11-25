# IARDA Warehouse Management System: one image for Render and for the internal server.
#   docker build -t iarda-wms .
#   docker run -p 3000:3000 --env-file .env iarda-wms
# The API serves the built web app and brand assets from the same origin. PDF export uses Chromium (Playwright).

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/demo/package.json apps/demo/
RUN npm ci --workspaces --include-workspace-root --ignore-scripts
COPY . .
ARG VITE_DEMO=0
RUN VITE_DEMO=$VITE_DEMO npm -w @iarda/web run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0 STORAGE_DIR=/data/storage \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright NODE_PATH=/opt/pw/node_modules TZ=Asia/Riyadh
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/demo/package.json apps/demo/
RUN npm ci --omit=dev --workspace @iarda/api --workspace @iarda/shared --include-workspace-root --ignore-scripts \
 && npm install --prefix /opt/pw --no-save --no-package-lock playwright@1.63.0 \
 && /opt/pw/node_modules/.bin/playwright install --with-deps chromium \
 && npm cache clean --force && rm -rf /var/lib/apt/lists/*
COPY packages/shared packages/shared
COPY apps/api apps/api
COPY reports reports
COPY brand brand
COPY email email
COPY scripts/backup.sh scripts/restore.sh scripts/docker-entrypoint.sh scripts/
COPY --from=build /app/apps/web/dist apps/web/dist
RUN mkdir -p /data/storage && chown -R node:node /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
CMD ["node", "--import", "tsx", "apps/api/src/boot.ts"]
