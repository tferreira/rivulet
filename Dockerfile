FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production RIVULET_HOST=0.0.0.0 PORT=7380
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY bin ./bin
COPY src ./src
COPY public ./public
USER node
EXPOSE 7380
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:7380/healthz || exit 1
ENTRYPOINT ["node", "bin/rivulet.js"]
