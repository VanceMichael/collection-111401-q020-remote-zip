FROM node:22.23.4-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY . .
CMD ["npm", "run", "demo"]
