# API, generator and test image: Node 24 runs the TypeScript sources directly (type stripping), no build step.
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/domain/package.json packages/domain/
COPY packages/motion/package.json packages/motion/
COPY packages/telemetry/package.json packages/telemetry/
COPY packages/sdk/package.json packages/sdk/
RUN npm ci --workspaces --include-workspace-root --ignore-scripts && npm cache clean --force
COPY . .
RUN chown node:node /app && chown -R node:node /app/data
USER node
