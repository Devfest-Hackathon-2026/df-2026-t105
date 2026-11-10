# Cloud Run 用。画面をビルドし、中継サーバー（server/index.mjs）で配信する。
# GEMINI_API_KEY は Secret Manager から環境変数として渡す（イメージには入れない）。
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx vite build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY server ./server
EXPOSE 8080
CMD ["node", "server/index.mjs"]
