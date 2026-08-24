import {mkdir, writeFile} from "node:fs/promises";
import {dirname} from "node:path";

const files = new Map();

files.set("package.json", String.raw`{
  "name": "personalised-post-purchase",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=22.12 <23"
  },
  "workspaces": [
    "extensions/*"
  ],
  "scripts": {
    "build": "react-router build",
    "dev": "npm run configure:extension && shopify app dev",
    "predeploy": "npm run configure:extension",
    "deploy": "shopify app deploy",
    "start": "node scripts/start.mjs",
    "setup": "prisma generate && prisma migrate deploy",
    "configure:extension": "node scripts/write-extension-config.mjs",
    "prisma:validate": "prisma validate",
    "lint": "eslint . --max-warnings=0",
    "test": "node --test tests/*.test.mjs",
    "typecheck": "react-router typegen",
    "extension:build": "npm run configure:extension && esbuild extensions/personalised-post-purchase/src/index.jsx --bundle --minify --platform=browser --format=iife --outfile=.tmp/post-purchase.js",
    "validate": "npm run prisma:validate && npm run typecheck && npm run lint && npm test && npm run build && npm run extension:build",
    "docker:build": "docker build -t personalised-post-purchase ."
  },
  "dependencies": {
    "@prisma/client": "6.19.0",
    "@react-router/node": "7.12.0",
    "@react-router/serve": "7.12.0",
    "@shopify/shopify-api": "14.0.0",
    "@shopify/shopify-app-react-router": "2.0.0",
    "@shopify/shopify-app-session-storage-prisma": "10.0.0",
    "isbot": "5.1.31",
    "jose": "6.1.0",
    "prisma": "6.19.0",
    "react": "18.3.1",
    "react-dom": "18.3.1",
    "react-router": "7.12.0"
  },
  "devDependencies": {
    "@react-router/dev": "7.12.0",
    "@react-router/fs-routes": "7.12.0",
    "@shopify/cli": "4.7.0",
    "@types/node": "22.19.0",
    "@types/react": "18.3.25",
    "@types/react-dom": "18.3.7",
    "esbuild": "0.28.1",
    "eslint": "8.57.1",
    "eslint-import-resolver-typescript": "4.4.4",
    "eslint-plugin-import": "2.32.0",
    "eslint-plugin-jsx-a11y": "6.10.2",
    "eslint-plugin-react": "7.37.5",
    "eslint-plugin-react-hooks": "7.0.1",
    "typescript": "5.9.3",
    "vite": "7.3.1",
    "vite-tsconfig-paths": "6.0.4"
  }
}
`);

files.set(".npmrc", String.raw`engine-strict=true
fund=false
audit=true
`);

files.set("tsconfig.json", String.raw`{
  "include": ["env.d.ts", "**/*.js", "**/*.jsx", ".react-router/types/**/*"],
  "compilerOptions": {
    "lib": ["DOM", "DOM.Iterable", "ES2022"],
    "strict": false,
    "skipLibCheck": true,
    "isolatedModules": true,
    "allowSyntheticDefaultImports": true,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true,
    "allowJs": true,
    "checkJs": false,
    "resolveJsonModule": true,
    "jsx": "react-jsx",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "target": "ES2022",
    "baseUrl": ".",
    "types": ["@react-router/node", "vite/client"],
    "rootDirs": [".", "./.react-router/types"]
  }
}
`);

files.set("env.d.ts", String.raw`/// <reference types="vite/client" />
/// <reference types="@react-router/node" />
`);

files.set("react-router.config.js", String.raw`/** @type {import('@react-router/dev/config').Config} */
export default {
  ssr: true,
};
`);

files.set("vite.config.js", String.raw`import {reactRouter} from "@react-router/dev/vite";
import {defineConfig} from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [reactRouter(), tsconfigPaths()],
  server: {
    allowedHosts: true,
  },
});
`);

files.set(".eslintrc.cjs", String.raw`module.exports = {
  root: true,
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
    ecmaFeatures: {jsx: true},
  },
  env: {
    browser: true,
    es2022: true,
    node: true,
  },
  ignorePatterns: [
    "build/",
    ".react-router/",
    ".tmp/",
    "node_modules/",
    "extensions/personalised-post-purchase/src/app-url.js",
  ],
  extends: ["eslint:recommended"],
  overrides: [
    {
      files: ["**/*.{js,jsx}"],
      plugins: ["react", "react-hooks", "jsx-a11y", "import"],
      extends: [
        "plugin:react/recommended",
        "plugin:react/jsx-runtime",
        "plugin:react-hooks/recommended",
        "plugin:jsx-a11y/recommended",
      ],
      settings: {
        react: {version: "detect"},
      },
      rules: {
        "react/prop-types": "off",
        "no-console": ["error", {allow: ["warn", "error"]}],
        "import/no-unresolved": "off",
      },
    },
  ],
  globals: {
    shopify: "readonly",
  },
};
`);

files.set(".gitignore", String.raw`node_modules/
.env
.env.*
!.env.example
.shopify/
build/
dist/
.react-router/
.vite/
.tmp/
coverage/
*.log
.DS_Store
.idea/
.vscode/
prisma/dev.db*
*.sqlite
*.sqlite3
`);

files.set(".dockerignore", String.raw`node_modules
.git
.github
.shopify
build
.react-router
.tmp
.env*
*.log
`);

files.set(".env.example", String.raw`NODE_ENV=development
SHOPIFY_API_KEY=replace_me
SHOPIFY_API_SECRET=replace_me
SHOPIFY_APP_URL=https://replace-me.example.com
SCOPES=read_products,read_orders
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/personalised_upsell?schema=public
CRON_SECRET=replace_with_at_least_32_random_characters
PORT=3000
`);

files.set("shopify.app.toml", String.raw`client_id = ""
name = "Personalised Post Purchase"
application_url = "https://REPLACE_WITH_PRODUCTION_DOMAIN"
embedded = true

[build]
automatically_update_urls_on_dev = true

[access_scopes]
scopes = "read_products,read_orders"

[auth]
redirect_urls = [
  "https://REPLACE_WITH_PRODUCTION_DOMAIN/auth/callback",
  "https://REPLACE_WITH_PRODUCTION_DOMAIN/auth/shopify/callback",
  "https://REPLACE_WITH_PRODUCTION_DOMAIN/api/auth/callback"
]

[webhooks]
api_version = "2026-07"

[[webhooks.subscriptions]]
topics = ["app/uninstalled"]
uri = "/webhooks/app/uninstalled"

[[webhooks.subscriptions]]
topics = ["app/scopes_update"]
uri = "/webhooks/app/scopes_update"

[[webhooks.subscriptions]]
topics = ["orders/updated"]
uri = "/webhooks/orders/updated"

[[webhooks.subscriptions]]
compliance_topics = ["customers/data_request"]
uri = "/webhooks/customers/data_request"

[[webhooks.subscriptions]]
compliance_topics = ["customers/redact"]
uri = "/webhooks/customers/redact"

[[webhooks.subscriptions]]
compliance_topics = ["shop/redact"]
uri = "/webhooks/shop/redact"
`);

files.set("shopify.web.toml", String.raw`roles = ["frontend", "backend"]

[commands]
predev = "npx prisma generate"
dev = "npm exec react-router dev"
`);

files.set("Dockerfile", String.raw`FROM node:22.12-alpine AS dependencies
WORKDIR /app
RUN apk add --no-cache openssl
COPY package.json package-lock.json .npmrc ./
COPY extensions/personalised-post-purchase/package.json ./extensions/personalised-post-purchase/package.json
RUN npm ci

FROM dependencies AS build
COPY . .
RUN npx prisma generate
RUN SHOPIFY_APP_URL=https://build.example.com npm run build
RUN SHOPIFY_APP_URL=https://build.example.com npm run extension:build
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
`);

files.set("docker-compose.yml", String.raw`services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: personalised_upsell
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d personalised_upsell"]
      interval: 5s
      timeout: 5s
      retries: 10

volumes:
  postgres_data:
`);

files.set("scripts/write-extension-config.mjs", String.raw`import {mkdir, writeFile} from "node:fs/promises";
import {URL} from "node:url";

const raw = process.env.SHOPIFY_APP_URL || "";
if (!raw) {
  throw new Error("SHOPIFY_APP_URL is required before building or deploying the extension.");
}

const parsed = new URL(raw);
const isLocal = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
if (parsed.protocol !== "https:" && !isLocal) {
  throw new Error("SHOPIFY_APP_URL must use HTTPS outside local development.");
}

const appUrl = raw.replace(/\/$/, "");
const destination = new URL("../extensions/personalised-post-purchase/src/app-url.js", import.meta.url);
await mkdir(new URL("../extensions/personalised-post-purchase/src/", import.meta.url), {recursive: true});
await writeFile(destination, "export const APP_URL = " + JSON.stringify(appUrl) + ";\n", "utf8");
`);

files.set("scripts/start.mjs", String.raw`import {spawn} from "node:child_process";

const required = [
  "SHOPIFY_API_KEY",
  "SHOPIFY_API_SECRET",
  "SHOPIFY_APP_URL",
  "SCOPES",
  "DATABASE_URL",
  "CRON_SECRET",
];

const missing = required.filter(function (name) {
  return !process.env[name];
});

if (missing.length) {
  throw new Error("Missing required environment variables: " + missing.join(", "));
}

if (process.env.NODE_ENV === "production" && !process.env.SHOPIFY_APP_URL.startsWith("https://")) {
  throw new Error("SHOPIFY_APP_URL must use HTTPS in production.");
}

async function run(command, args) {
  await new Promise(function (resolve, reject) {
    const child = spawn(command, args, {stdio: "inherit", env: process.env});
    child.on("error", reject);
    child.on("exit", function (code) {
      if (code === 0) resolve();
      else reject(new Error(command + " exited with code " + code));
    });
  });
}

await run("./node_modules/.bin/prisma", ["migrate", "deploy"]);

const server = spawn(
  "./node_modules/.bin/react-router-serve",
  ["./build/server/index.js"],
  {stdio: "inherit", env: process.env},
);

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, function () {
    server.kill(signal);
  });
}

server.on("exit", function (code, signal) {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code || 0);
});
`);

files.set("prisma/schema.prisma", String.raw`generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum OfferStatus {
  DRAFT
  ACTIVE
  ARCHIVED
}

enum DiscountType {
  NONE
  PERCENTAGE
  FIXED
}

enum FieldType {
  SHORT_TEXT
  LONG_TEXT
  SELECT
  CHECKBOX
}

enum AcceptanceStatus {
  PENDING
  SIGNED
  PROCESSED
  PARTIAL
  FAILED
  REDACTED
}

enum ProductionStatus {
  NEW
  APPROVED
  IN_PRODUCTION
  COMPLETED
  CANCELLED
}

enum EventType {
  VIEW
  ACCEPT
  DECLINE
  ERROR
}

enum PrivacyRequestType {
  DATA_REQUEST
  CUSTOMER_REDACT
  SHOP_REDACT
}

enum PrivacyRequestStatus {
  RECEIVED
  COMPLETE
  FAILED
}

model Session {
  id                  String    @id
  shop                String
  state               String
  isOnline            Boolean   @default(false)
  scope               String?
  expires             DateTime?
  accessToken         String
  userId              BigInt?
  firstName           String?
  lastName            String?
  email               String?
  accountOwner        Boolean   @default(false)
  locale              String?
  collaborator        Boolean?  @default(false)
  emailVerified       Boolean?  @default(false)
  refreshToken        String?
  refreshTokenExpires DateTime?

  @@index([shop])
}

model Shop {
  id             String           @id @default(cuid())
  domain         String           @unique
  retentionDays  Int              @default(365)
  installedAt    DateTime         @default(now())
  uninstalledAt  DateTime?
  createdAt      DateTime         @default(now())
  updatedAt      DateTime         @updatedAt
  offers         Offer[]
  acceptances    Acceptance[]
  events         OfferEvent[]
  webhookReceipts WebhookReceipt[]
  privacyRequests PrivacyRequest[]
}

model Offer {
  id               String                 @id @default(cuid())
  shopId           String
  name             String
  status           OfferStatus            @default(DRAFT)
  priority         Int                    @default(0)
  productId        String
  productVariantId String
  productTitle     String
  variantTitle     String?
  productImageUrl  String?
  currencyCode     String                 @default("USD")
  catalogPrice     Decimal                @db.Decimal(18, 2)
  quantity         Int                    @default(1)
  discountType     DiscountType           @default(NONE)
  discountValue    Decimal                @default(0) @db.Decimal(18, 2)
  headline         String                 @default("Add a personalised gift")
  description      String?
  buttonLabel      String                 @default("Add personalised item")
  rules            Json                   @default("{}")
  startsAt         DateTime?
  endsAt           DateTime?
  createdAt        DateTime               @default(now())
  updatedAt        DateTime               @updatedAt
  shop             Shop                   @relation(fields: [shopId], references: [id], onDelete: Cascade)
  fields           PersonalisationField[]
  acceptances      Acceptance[]
  events           OfferEvent[]

  @@index([shopId, status, priority])
}

model PersonalisationField {
  id          String    @id @default(cuid())
  offerId     String
  key         String
  type        FieldType
  label       String
  placeholder String?
  helpText    String?
  required    Boolean   @default(false)
  minLength   Int?
  maxLength   Int?
  options     Json      @default("[]")
  sortOrder   Int       @default(0)
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
  offer       Offer     @relation(fields: [offerId], references: [id], onDelete: Cascade)

  @@unique([offerId, key])
  @@index([offerId, sortOrder])
}

model Acceptance {
  id                 String             @id @default(cuid())
  shopId             String
  offerId            String
  referenceId        String
  idempotencyKey     String             @unique
  changesetJti       String?
  status             AcceptanceStatus   @default(PENDING)
  productionStatus   ProductionStatus   @default(NEW)
  orderId            String?
  orderName          String?
  customerId         String?
  customerEmailHash  String?
  personalisation    Json
  expectedAmount     Decimal            @default(0) @db.Decimal(18, 2)
  currencyCode       String             @default("USD")
  signedAt           DateTime?
  processedAt        DateTime?
  expiresAt          DateTime?
  createdAt          DateTime           @default(now())
  updatedAt          DateTime           @updatedAt
  shop               Shop               @relation(fields: [shopId], references: [id], onDelete: Cascade)
  offer              Offer              @relation(fields: [offerId], references: [id], onDelete: Restrict)

  @@unique([shopId, referenceId, offerId])
  @@index([shopId, productionStatus, createdAt])
  @@index([shopId, orderId])
  @@index([shopId, customerId])
  @@index([shopId, customerEmailHash])
}

model OfferEvent {
  id          String    @id @default(cuid())
  shopId      String
  offerId     String
  referenceId String
  type        EventType
  detail      Json      @default("{}")
  createdAt   DateTime  @default(now())
  shop        Shop      @relation(fields: [shopId], references: [id], onDelete: Cascade)
  offer       Offer     @relation(fields: [offerId], references: [id], onDelete: Cascade)

  @@unique([shopId, offerId, referenceId, type])
  @@index([shopId, createdAt])
}

model RateLimitBucket {
  key       String   @id
  count     Int      @default(0)
  resetAt   DateTime
  updatedAt DateTime @updatedAt

  @@index([resetAt])
}

model WebhookReceipt {
  id         String   @id
  shopId     String?
  topic      String
  receivedAt DateTime @default(now())
  shop       Shop?    @relation(fields: [shopId], references: [id], onDelete: Cascade)

  @@index([receivedAt])
}

model PrivacyRequest {
  id          String               @id @default(cuid())
  shopId      String?
  shopDomain  String
  requestType PrivacyRequestType
  status      PrivacyRequestStatus @default(RECEIVED)
  customerId  String?
  customerEmailHash String?
  result      Json?
  error       String?
  expiresAt   DateTime
  createdAt   DateTime             @default(now())
  completedAt DateTime?
  shop        Shop?                @relation(fields: [shopId], references: [id], onDelete: Cascade)

  @@index([shopDomain, createdAt])
  @@index([expiresAt])
}
`);

files.set("prisma/migrations/migration_lock.toml", String.raw`provider = "postgresql"
`);

files.set("prisma/migrations/20260824000000_initial/migration.sql", String.raw`CREATE TYPE "OfferStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');
CREATE TYPE "DiscountType" AS ENUM ('NONE', 'PERCENTAGE', 'FIXED');
CREATE TYPE "FieldType" AS ENUM ('SHORT_TEXT', 'LONG_TEXT', 'SELECT', 'CHECKBOX');
CREATE TYPE "AcceptanceStatus" AS ENUM ('PENDING', 'SIGNED', 'PROCESSED', 'PARTIAL', 'FAILED', 'REDACTED');
CREATE TYPE "ProductionStatus" AS ENUM ('NEW', 'APPROVED', 'IN_PRODUCTION', 'COMPLETED', 'CANCELLED');
CREATE TYPE "EventType" AS ENUM ('VIEW', 'ACCEPT', 'DECLINE', 'ERROR');
CREATE TYPE "PrivacyRequestType" AS ENUM ('DATA_REQUEST', 'CUSTOMER_REDACT', 'SHOP_REDACT');
CREATE TYPE "PrivacyRequestStatus" AS ENUM ('RECEIVED', 'COMPLETE', 'FAILED');

CREATE TABLE "Session" (
  "id" TEXT NOT NULL,
  "shop" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "isOnline" BOOLEAN NOT NULL DEFAULT false,
  "scope" TEXT,
  "expires" TIMESTAMP(3),
  "accessToken" TEXT NOT NULL,
  "userId" BIGINT,
  "firstName" TEXT,
  "lastName" TEXT,
  "email" TEXT,
  "accountOwner" BOOLEAN NOT NULL DEFAULT false,
  "locale" TEXT,
  "collaborator" BOOLEAN DEFAULT false,
  "emailVerified" BOOLEAN DEFAULT false,
  "refreshToken" TEXT,
  "refreshTokenExpires" TIMESTAMP(3),
  CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Shop" (
  "id" TEXT NOT NULL,
  "domain" TEXT NOT NULL,
  "retentionDays" INTEGER NOT NULL DEFAULT 365,
  "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "uninstalledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Offer" (
  "id" TEXT NOT NULL,
  "shopId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "status" "OfferStatus" NOT NULL DEFAULT 'DRAFT',
  "priority" INTEGER NOT NULL DEFAULT 0,
  "productId" TEXT NOT NULL,
  "productVariantId" TEXT NOT NULL,
  "productTitle" TEXT NOT NULL,
  "variantTitle" TEXT,
  "productImageUrl" TEXT,
  "currencyCode" TEXT NOT NULL DEFAULT 'USD',
  "catalogPrice" DECIMAL(18,2) NOT NULL,
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "discountType" "DiscountType" NOT NULL DEFAULT 'NONE',
  "discountValue" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "headline" TEXT NOT NULL DEFAULT 'Add a personalised gift',
  "description" TEXT,
  "buttonLabel" TEXT NOT NULL DEFAULT 'Add personalised item',
  "rules" JSONB NOT NULL DEFAULT '{}',
  "startsAt" TIMESTAMP(3),
  "endsAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Offer_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PersonalisationField" (
  "id" TEXT NOT NULL,
  "offerId" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "type" "FieldType" NOT NULL,
  "label" TEXT NOT NULL,
  "placeholder" TEXT,
  "helpText" TEXT,
  "required" BOOLEAN NOT NULL DEFAULT false,
  "minLength" INTEGER,
  "maxLength" INTEGER,
  "options" JSONB NOT NULL DEFAULT '[]',
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PersonalisationField_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Acceptance" (
  "id" TEXT NOT NULL,
  "shopId" TEXT NOT NULL,
  "offerId" TEXT NOT NULL,
  "referenceId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "changesetJti" TEXT,
  "status" "AcceptanceStatus" NOT NULL DEFAULT 'PENDING',
  "productionStatus" "ProductionStatus" NOT NULL DEFAULT 'NEW',
  "orderId" TEXT,
  "orderName" TEXT,
  "customerId" TEXT,
  "customerEmailHash" TEXT,
  "personalisation" JSONB NOT NULL,
  "expectedAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "currencyCode" TEXT NOT NULL DEFAULT 'USD',
  "signedAt" TIMESTAMP(3),
  "processedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Acceptance_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OfferEvent" (
  "id" TEXT NOT NULL,
  "shopId" TEXT NOT NULL,
  "offerId" TEXT NOT NULL,
  "referenceId" TEXT NOT NULL,
  "type" "EventType" NOT NULL,
  "detail" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OfferEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RateLimitBucket" (
  "key" TEXT NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 0,
  "resetAt" TIMESTAMP(3) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RateLimitBucket_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "WebhookReceipt" (
  "id" TEXT NOT NULL,
  "shopId" TEXT,
  "topic" TEXT NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WebhookReceipt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PrivacyRequest" (
  "id" TEXT NOT NULL,
  "shopId" TEXT,
  "shopDomain" TEXT NOT NULL,
  "requestType" "PrivacyRequestType" NOT NULL,
  "status" "PrivacyRequestStatus" NOT NULL DEFAULT 'RECEIVED',
  "customerId" TEXT,
  "customerEmailHash" TEXT,
  "result" JSONB,
  "error" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "PrivacyRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Shop_domain_key" ON "Shop"("domain");
CREATE INDEX "Session_shop_idx" ON "Session"("shop");
CREATE INDEX "Offer_shopId_status_priority_idx" ON "Offer"("shopId", "status", "priority");
CREATE UNIQUE INDEX "PersonalisationField_offerId_key_key" ON "PersonalisationField"("offerId", "key");
CREATE INDEX "PersonalisationField_offerId_sortOrder_idx" ON "PersonalisationField"("offerId", "sortOrder");
CREATE UNIQUE INDEX "Acceptance_idempotencyKey_key" ON "Acceptance"("idempotencyKey");
CREATE UNIQUE INDEX "Acceptance_shopId_referenceId_offerId_key" ON "Acceptance"("shopId", "referenceId", "offerId");
CREATE INDEX "Acceptance_shopId_productionStatus_createdAt_idx" ON "Acceptance"("shopId", "productionStatus", "createdAt");
CREATE INDEX "Acceptance_shopId_orderId_idx" ON "Acceptance"("shopId", "orderId");
CREATE INDEX "Acceptance_shopId_customerId_idx" ON "Acceptance"("shopId", "customerId");
CREATE INDEX "Acceptance_shopId_customerEmailHash_idx" ON "Acceptance"("shopId", "customerEmailHash");
CREATE UNIQUE INDEX "OfferEvent_shopId_offerId_referenceId_type_key" ON "OfferEvent"("shopId", "offerId", "referenceId", "type");
CREATE INDEX "OfferEvent_shopId_createdAt_idx" ON "OfferEvent"("shopId", "createdAt");
CREATE INDEX "RateLimitBucket_resetAt_idx" ON "RateLimitBucket"("resetAt");
CREATE INDEX "WebhookReceipt_receivedAt_idx" ON "WebhookReceipt"("receivedAt");
CREATE INDEX "PrivacyRequest_shopDomain_createdAt_idx" ON "PrivacyRequest"("shopDomain", "createdAt");
CREATE INDEX "PrivacyRequest_expiresAt_idx" ON "PrivacyRequest"("expiresAt");

ALTER TABLE "Offer" ADD CONSTRAINT "Offer_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PersonalisationField" ADD CONSTRAINT "PersonalisationField_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "Offer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Acceptance" ADD CONSTRAINT "Acceptance_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Acceptance" ADD CONSTRAINT "Acceptance_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "Offer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OfferEvent" ADD CONSTRAINT "OfferEvent_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OfferEvent" ADD CONSTRAINT "OfferEvent_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "Offer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WebhookReceipt" ADD CONSTRAINT "WebhookReceipt_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PrivacyRequest" ADD CONSTRAINT "PrivacyRequest_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
`);

files.set("app/db.server.js", String.raw`import {PrismaClient} from "@prisma/client";

const globalForPrisma = globalThis;

const prisma = globalForPrisma.__personalisedUpsellPrisma || new PrismaClient({
  log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
});

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.__personalisedUpsellPrisma = prisma;
}

export default prisma;
`);

files.set("app/lib/env.server.js", String.raw`const REQUIRED = [
  "SHOPIFY_API_KEY",
  "SHOPIFY_API_SECRET",
  "SHOPIFY_APP_URL",
  "SCOPES",
  "DATABASE_URL",
  "CRON_SECRET",
];

export function requireRuntimeEnvironment() {
  const missing = REQUIRED.filter(function (name) {
    return !process.env[name];
  });
  if (missing.length) {
    throw new Error("Missing required environment variables: " + missing.join(", "));
  }
  if (process.env.NODE_ENV === "production") {
    if (!process.env.SHOPIFY_APP_URL.startsWith("https://")) {
      throw new Error("SHOPIFY_APP_URL must use HTTPS in production.");
    }
    if (process.env.CRON_SECRET.length < 32) {
      throw new Error("CRON_SECRET must contain at least 32 characters.");
    }
  }
}

export function getEnv(name, fallback) {
  const value = process.env[name] || fallback;
  if (value === undefined) throw new Error("Missing environment variable: " + name);
  return value;
}
`);

files.set("app/lib/shop.server.js", String.raw`import prisma from "../db.server";

export function normalizeShop(value) {
  const text = String(value || "").trim().toLowerCase();
  const withoutProtocol = text.replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(withoutProtocol)) {
    throw new Error("Invalid Shopify shop domain.");
  }
  return withoutProtocol;
}

export async function ensureShop(domain) {
  const shopDomain = normalizeShop(domain);
  return prisma.shop.upsert({
    where: {domain: shopDomain},
    create: {domain: shopDomain},
    update: {uninstalledAt: null},
  });
}

export async function shopForSession(session) {
  if (!session || !session.shop) throw new Response("Unauthorized", {status: 401});
  return ensureShop(session.shop);
}
`);

files.set("app/lib/responses.server.js", String.raw`export function jsonResponse(body, init) {
  const options = init || {};
  const headers = new Headers(options.headers || {});
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(JSON.stringify(body), {
    status: options.status || 200,
    headers: headers,
  });
}

export async function readJson(request, maximumBytes) {
  const limit = maximumBytes || 32768;
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > limit) throw new Response("Payload too large", {status: 413});
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > limit) {
    throw new Response("Payload too large", {status: 413});
  }
  try {
    return JSON.parse(text || "{}");
  } catch {
    throw new Response("Invalid JSON", {status: 400});
  }
}

export function publicError(error) {
  if (error instanceof Response) return error;
  console.error(error);
  return jsonResponse({error: "The request could not be completed."}, {status: 500});
}
`);

files.set("app/lib/security.server.js", String.raw`import {createHash, randomUUID} from "node:crypto";
import {SignJWT, jwtVerify} from "jose";
import prisma from "../db.server";
import {getEnv} from "./env.server";

function signingKey() {
  return new TextEncoder().encode(getEnv("SHOPIFY_API_SECRET", "development-secret"));
}

export function hashCustomerEmail(email) {
  const normalized = String(email || "").trim().toLowerCase();
  if (!normalized) return null;
  return createHash("sha256").update(normalized).digest("hex");
}

export async function signOfferToken(payload) {
  return new SignJWT({
    shop: payload.shop,
    offerId: payload.offerId,
    contextHash: payload.contextHash,
  })
    .setProtectedHeader({alg: "HS256", typ: "JWT"})
    .setIssuer(getEnv("SHOPIFY_API_KEY", "development-key"))
    .setAudience("personalised-post-purchase")
    .setSubject(payload.referenceId)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(signingKey());
}

export async function verifyOfferToken(token) {
  const verified = await jwtVerify(String(token || ""), signingKey(), {
    issuer: getEnv("SHOPIFY_API_KEY", "development-key"),
    audience: "personalised-post-purchase",
  });
  return verified.payload;
}

export async function signShopifyChangeset(referenceId, changes, jti) {
  return new SignJWT({changes: changes})
    .setProtectedHeader({alg: "HS256", typ: "JWT"})
    .setIssuer(getEnv("SHOPIFY_API_KEY", "development-key"))
    .setSubject(referenceId)
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(signingKey());
}

export function stableContextHash(value) {
  const canonical = JSON.stringify(value, Object.keys(value || {}).sort());
  return createHash("sha256").update(canonical).digest("hex");
}

export async function enforceRateLimit(key, limit, windowSeconds) {
  const now = new Date();
  const window = Math.floor(now.getTime() / (windowSeconds * 1000));
  const bucketKey = key + ":" + window;
  const resetAt = new Date((window + 1) * windowSeconds * 1000);
  const bucket = await prisma.rateLimitBucket.upsert({
    where: {key: bucketKey},
    create: {key: bucketKey, count: 1, resetAt: resetAt},
    update: {count: {increment: 1}, resetAt: resetAt},
  });
  if (bucket.count > limit) {
    throw new Response("Too many requests", {
      status: 429,
      headers: {"Retry-After": String(Math.max(1, Math.ceil((resetAt.getTime() - now.getTime()) / 1000)))},
    });
  }
}

export async function recordWebhook(request, shopId, topic) {
  const webhookId = request.headers.get("x-shopify-webhook-id") || randomUUID();
  try {
    await prisma.webhookReceipt.create({
      data: {id: webhookId, shopId: shopId || null, topic: String(topic || "unknown")},
    });
    return true;
  } catch (error) {
    if (error && error.code === "P2002") return false;
    throw error;
  }
}
`);

for (const [path, content] of files) {
  await mkdir(dirname(path), {recursive: true});
  await writeFile(path, content, "utf8");
}
