FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=8500
EXPOSE 8500
CMD ["node", "server.js"]
