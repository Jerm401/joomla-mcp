FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build && npm prune --omit=dev

ENV HTTP_PORT=8080

CMD ["node", "dist/index.js"]
