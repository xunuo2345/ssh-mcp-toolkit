FROM node:20-bookworm-slim AS test

WORKDIR /app
ENV NODE_ENV=development

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
COPY test ./test
RUN npm run build

ENV SSH_MCP_DISABLE_MAIN=1
CMD ["npm", "run", "test:container"]

FROM node:20-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=test /app/build ./build

USER node
ENTRYPOINT ["node", "build/index.js"]
