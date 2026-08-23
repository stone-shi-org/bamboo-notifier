FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY server.js ./
COPY config ./config
COPY public ./public
COPY version.txt* ./

ENV PORT=3000
EXPOSE 3000

USER node

CMD ["node", "server.js"]
