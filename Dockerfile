FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

# Aucune dépendance npm : on copie simplement le code et les données.
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node data ./data
COPY --chown=node:node public ./public

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" || exit 1

CMD ["node", "src/server.js"]
