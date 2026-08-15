FROM node:20-slim
WORKDIR /app
COPY . .
ENV DATA_DIR=/data
CMD ["node", "bot.mjs"]
