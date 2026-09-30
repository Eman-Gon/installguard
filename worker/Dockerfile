ARG NODE_VERSION=22.11.0
FROM node:${NODE_VERSION}-bookworm-slim
WORKDIR /opt/bootstrap
ARG CACHE_FIXTURE=csv-broken
COPY fixtures/${CACHE_FIXTURE}/package.json fixtures/${CACHE_FIXTURE}/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund --cache /opt/npm-cache && chmod -R a+rX /opt/npm-cache
COPY worker/container-entry.mjs /opt/container-entry.mjs
USER node
CMD ["node", "/opt/container-entry.mjs"]
