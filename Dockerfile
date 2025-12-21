FROM node:20-slim

WORKDIR /app

# Runtime-only image: assumes dist has been built outside the container.
COPY dist ./dist
COPY package*.json ./

CMD ["node", "dist/main.js"]


