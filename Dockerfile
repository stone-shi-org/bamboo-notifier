FROM node:22-alpine

# su-exec: lets docker-entrypoint.sh start as root (to fix up /app/data ownership on a
# freshly-bind-mounted volume) and then drop to the unprivileged "node" user before
# running any app code - see docker-entrypoint.sh.
RUN apk add --no-cache su-exec

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY server.js db.js docker-entrypoint.sh ./
COPY config ./config
COPY public ./public
COPY version.txt* ./
RUN chmod +x docker-entrypoint.sh

ENV PORT=3000
EXPOSE 3000

# Intentionally stays root here - docker-entrypoint.sh drops to "node" itself.
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
