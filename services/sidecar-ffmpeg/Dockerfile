FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY src ./src
ENV NODE_ENV=production
ENV PORT=3100
EXPOSE 3100
CMD ["node", "src/server.js"]
