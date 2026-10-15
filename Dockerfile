FROM node:26-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY aops ./aops
COPY public ./public
EXPOSE 8080
ENV PORT=8080
ENV STATE_DIR=/data
# Starts as root only to hand the mounted volume to the unprivileged node user,
# then drops privileges for the app process.
CMD ["sh", "-c", "mkdir -p /data && chown node:node /data && exec setpriv --reuid=node --regid=node --init-groups node src/server.ts"]
