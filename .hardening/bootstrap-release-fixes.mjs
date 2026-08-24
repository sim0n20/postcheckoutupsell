import {writeFile} from "node:fs/promises";

await writeFile("Dockerfile", String.raw`FROM node:22.12-alpine AS dependencies
WORKDIR /app
RUN apk add --no-cache openssl
COPY package.json package-lock.json .npmrc ./
COPY extensions/personalised-post-purchase/package.json ./extensions/personalised-post-purchase/package.json
RUN npm ci

FROM dependencies AS build
WORKDIR /app
ARG SHOPIFY_APP_URL=https://build.example.com
ENV SHOPIFY_APP_URL=$SHOPIFY_APP_URL
ENV SHOPIFY_API_KEY=container_build_key
ENV SHOPIFY_API_SECRET=container_build_secret
ENV SCOPES=read_products,read_orders
ENV DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/build?schema=public
ENV CRON_SECRET=container_build_cron_secret_32_chars
COPY . .
RUN npx prisma generate
RUN npm run build
RUN npm run extension:build
RUN npm prune --omit=dev

FROM node:22.12-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache openssl tini && addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/build ./build
COPY --from=build --chown=app:app /app/prisma ./prisma
COPY --from=build --chown=app:app /app/scripts ./scripts
COPY --from=build --chown=app:app /app/package.json ./package.json
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD wget -q -O - http://127.0.0.1:3000/api/health || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "scripts/start.mjs"]
`, "utf8");
