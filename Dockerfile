FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.mjs telegram-auth.mjs rooms.mjs match-flow.mjs test-flow.mjs ./
ENV NODE_ENV=production
EXPOSE 3000
RUN node --check server.mjs && node --check telegram-auth.mjs && node --check rooms.mjs && node --check match-flow.mjs && node test-flow.mjs
CMD ["node","server.mjs"]
