# 考勤系统后端镜像（在 AttendanceSystem 项目根目录构建）
FROM node:20-alpine

WORKDIR /app

# 先装依赖（利用 Docker 层缓存，代码改动后无需重装）
COPY server/package.json ./server/package.json
RUN cd server && npm install --omit=dev --registry=https://registry.npmmirror.com

# 拷贝后端代码与前端静态页
# 代码里静态目录是 path.join(__dirname, '../../public')，
# __dirname = /app/server/src，因此 public 必须落在 /app/public
COPY server/src ./server/src
COPY public ./public

WORKDIR /app/server

EXPOSE 3000
CMD ["node", "src/index.js"]
