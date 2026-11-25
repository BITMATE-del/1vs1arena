FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.mjs telegram-auth.mjs rooms.mjs match-flow.mjs match-board.mjs game-emojis.mjs special-rules.mjs match-watch.mjs classic-rules.mjs admin-results.mjs test-admin-results.mjs test-classic.mjs test-watch.mjs test-flow.mjs test-board.mjs test-games.mjs test-special.mjs ./
ENV NODE_ENV=production
EXPOSE 3000
RUN node --check server.mjs && node --check telegram-auth.mjs && node --check rooms.mjs && node --check match-flow.mjs && node --check match-board.mjs && node --check game-emojis.mjs && node --check special-rules.mjs && node --check match-watch.mjs && node --check classic-rules.mjs && node --check admin-results.mjs && node test-admin-results.mjs && node test-classic.mjs && node test-watch.mjs && node test-flow.mjs && node test-board.mjs && node test-games.mjs && node test-special.mjs
CMD ["node","server.mjs"]
