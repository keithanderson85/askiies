FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js admin.html bugs.js ./
# `docker exec askiies-mp bugs ...` : the bug list from a terminal (see bugs.js)
RUN mkdir -p /data && chown node:node /data && \
    printf '#!/bin/sh\nexec node --disable-warning=ExperimentalWarning /app/bugs.js "$@"\n' > /usr/local/bin/bugs && chmod +x /usr/local/bin/bugs
USER node
ENV NODE_ENV=production PORT=8080 DB_PATH=/data/askiies.db
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/health || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
