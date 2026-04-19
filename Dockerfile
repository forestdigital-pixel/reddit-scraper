FROM node:22-slim

WORKDIR /app

# Copy package files and install dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

# Copy migration files (needed at runtime)
RUN cp -r src/db/migrations dist/db/migrations

EXPOSE 3000

CMD ["sh", "-c", "node dist/db/migrate.js 2>&1 || echo 'WARNING: Migration failed, check logs above'; exec node dist/index.js"]
