FROM node:22-alpine

WORKDIR /usr/src/app

# Copy dependency manifests
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production

# Copy application source code
COPY . .

EXPOSE 3000

CMD ["node", "server.js"]