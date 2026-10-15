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
CMD ["node", "src/server.ts"]
