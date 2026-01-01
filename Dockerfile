FROM node:20-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN chmod +x runner.sh
CMD ["./runner.sh"]


