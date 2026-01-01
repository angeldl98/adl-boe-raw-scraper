FROM mcr.microsoft.com/playwright:v1.57.0-jammy

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .

ENV PLAYWRIGHT_BROWSERS_PATH=0
CMD ["npm","start"]


