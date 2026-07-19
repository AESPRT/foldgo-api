FROM node:22-alpine

WORKDIR /usr/src/app

# Copy dependency manifests first
COPY package*.json ./

# 1. Install npx and generate the PayMongo SDK mapping in package.json first
RUN npx api install "@paymongo/v3#1fzuu181tmdopg9dp"

# 2. Run the clean production install so Node links the newly added @paymongo/v3 dependency
RUN npm ci --only=production

# 3. Copy the rest of your application code
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]