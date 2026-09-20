FROM node:22-bookworm-slim AS dependencies
WORKDIR /app/api
COPY api/package.json api/package-lock.json ./
COPY api/container-lock.mjs ./
RUN node container-lock.mjs \
    && npm ci --registry=https://registry.npmjs.org/ --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies --chown=node:node /app/api/node_modules ./api/node_modules
COPY --chown=node:node api/package.json ./api/package.json
COPY --chown=node:node api/dist ./api/dist
COPY --chown=node:node dist ./dist
RUN test -s dist/index.html && test -s dist/data/sdk-prs.json && test -s dist/data/emitter.json \
    && test -s api/dist/api/src/azure/main.js
USER node
EXPOSE 8080
CMD ["node", "api/dist/api/src/azure/main.js"]
