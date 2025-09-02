# ---- Dockerfile ----
FROM node:20-alpine

WORKDIR /app

# Install only production deps
COPY package*.json ./
RUN npm ci --omit=dev

# Copy everything except what’s ignored in .dockerignore
COPY . .

# Environment & port
ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787

# Start your server
CMD ["node", "src/server.js"]
