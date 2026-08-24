FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
COPY extensions/personalised-post-purchase/package.json ./extensions/personalised-post-purchase/package.json
RUN npm install --omit=dev=false
FROM deps AS build
COPY . .
RUN npx prisma generate && npm run build
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
EXPOSE 3000
CMD ["sh","-c","npx prisma migrate deploy && npm start"]
