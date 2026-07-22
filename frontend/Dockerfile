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
ARG VITE_GOOGLE_MAPS_API_KEY
ARG VITE_CADASTRAL_TILE_URL
ARG VITE_CADASTRAL_ATTRIBUTION
ARG VITE_CADASTRAL_OPACITY
ARG VITE_CADASTRAL_MAX_ZOOM
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
ENV VITE_GOOGLE_MAPS_API_KEY=$VITE_GOOGLE_MAPS_API_KEY
ENV VITE_CADASTRAL_TILE_URL=$VITE_CADASTRAL_TILE_URL
ENV VITE_CADASTRAL_ATTRIBUTION=$VITE_CADASTRAL_ATTRIBUTION
ENV VITE_CADASTRAL_OPACITY=$VITE_CADASTRAL_OPACITY
ENV VITE_CADASTRAL_MAX_ZOOM=$VITE_CADASTRAL_MAX_ZOOM
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
