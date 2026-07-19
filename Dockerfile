FROM node:22-alpine

WORKDIR /usr/src/app

# Copy dependency manifests
COPY package*.json ./

# 1. Install production dependencies
RUN npm ci --only=production

# 2. Automatically re-generate your custom PayMongo SDK inside the container
RUN npx api install "@paymongo/v3#1fzuu181tmdopg9dp"

# Copy the rest of your application code
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]