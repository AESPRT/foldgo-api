FROM node:22-alpine

WORKDIR /usr/src/app

# Copy lockfiles and manifests first for optimized caching layers
COPY package*.json ./

# Generate the PayMongo SDK source directories
RUN npx api install "@paymongo/v3#1fzuu181tmdopg9dp"

# Perform standard module linkage
RUN npm install --omit=dev

# Copy the rest of the application files
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]