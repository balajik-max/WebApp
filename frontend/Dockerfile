# ---- Stage 1: install ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json ./
RUN corepack enable && yarn install --frozen-lockfile 2>/dev/null || yarn install

# ---- Stage 2: dev server ----
FROM node:22-alpine AS dev
WORKDIR /app
ENV NODE_ENV=development
COPY --from=deps /app/node_modules /app/node_modules
COPY . /app
EXPOSE 3000
CMD ["yarn", "dev"]
