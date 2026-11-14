FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src
COPY scripts ./scripts

ENV NODE_ENV=production
EXPOSE 8080

USER node
CMD ["node", "src/app.js"]
