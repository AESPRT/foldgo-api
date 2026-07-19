FROM node:22-alpine

WORKDIR /usr/src/app

# Copy dependency manifests first
COPY package*.json ./

# 1. Generate the PayMongo SDK mapping in package.json
RUN npx api install "@paymongo/v3#1fzuu181tmdopg9dp"

# 2. Use npm install instead of npm ci so it links the dynamic SDK mapping
RUN npm install --omit=dev

# 3. Copy the rest of your application code
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]