FROM node:22-alpine AS builder
WORKDIR /app

# install deps
COPY package.json package-lock.json ./
RUN npm ci --silent

# build
COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# The same image runs the fail-fast SQL migration Job in Kubernetes.
RUN apk add --no-cache postgresql-client

# copy production assets
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/package-lock.json ./package-lock.json
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/migrations ./migrations
COPY --from=builder /app/scripts/apply-migrations.sh ./scripts/apply-migrations.sh

# install production deps
RUN npm ci --production --silent --legacy-peer-deps

EXPOSE 3100

USER node
CMD ["node", "dist/main.js"]
