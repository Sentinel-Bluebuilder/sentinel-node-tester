FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Create unprivileged user and group; set ownership so the process can
# write to /app (data/, results/) but cannot escalate privileges.
RUN addgroup -S sentinel && adduser -S sentinel -G sentinel \
    && chown -R sentinel:sentinel /app

EXPOSE 3001

HEALTHCHECK CMD wget -qO- http://localhost:3001/health || exit 1

# Drop to unprivileged user before launching the process.
USER sentinel

CMD ["node", "server.js"]
