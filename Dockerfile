FROM node:20-slim
WORKDIR /app
# Container defaultnya UTC — tanpa TZ, log, laporan jadwal harian, dan penanda
# "tanggal hari ini" semuanya ngikut UTC (geser 7 jam dari WIB).
ENV TZ=Asia/Jakarta
ENV DATA_DIR=/data
COPY . .
CMD ["node", "bot.mjs"]
