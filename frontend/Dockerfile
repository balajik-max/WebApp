# ---- Stage 1: install ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json yarn.lock ./
RUN corepack enable && yarn install --frozen-lockfile

# ---- Stage 2: build ----
FROM node:22-alpine AS build
WORKDIR /app
ENV NODE_ENV=production
ARG VITE_API_BASE_URL
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
COPY --from=deps /app/node_modules /app/node_modules
COPY . /app
RUN yarn build

# ---- Stage 3: production serve ----
FROM node:22-alpine AS production
WORKDIR /app
RUN npm install -g serve
COPY --from=build /app/dist ./dist
EXPOSE 3000
CMD ["serve", "dist", "-s", "-l", "3000"]
