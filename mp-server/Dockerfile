FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js admin.html ./
RUN mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production PORT=8080 DB_PATH=/data/askiies.db
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/health || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
