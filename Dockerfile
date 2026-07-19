FROM node:22-alpine

WORKDIR /usr/src/app

# Leverage caching for dependencies
COPY package*.json ./

# Install standard production modules cleanly 
RUN npm install --omit=dev

# Copy over the source directories
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]