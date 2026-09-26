FROM node:26-alpine

RUN apk add --no-cache openssl ca-certificates

ENV NODE_ENV=production

WORKDIR /app

COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
COPY node_modules ./node_modules
COPY dist ./dist

COPY src/views ./src/views

ENTRYPOINT ["node", "dist/cli.js"]

CMD ["serve"]
