FROM node:22-alpine

WORKDIR /usr/src/app

# 1. Copy ALL your application files into the container first
COPY . .

# 2. Run the API generator on top of the copied workspace
RUN npx api install "@paymongo/v3#1fzuu181tmdopg9dp"

# 3. Run npm install so it cleanly binds the newly added package maps
RUN npm install --omit=dev

EXPOSE 3000
CMD ["node", "server.js"]