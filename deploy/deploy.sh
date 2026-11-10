#!/usr/bin/env bash
# ============================================================
# 武汉一中管理平台 - 云服务器一键部署脚本
# 适用系统: Ubuntu 22.04 / 24.04 (Debian 12 亦可)
#
# 用法: 将整个 AttendanceSystem 项目上传到 /opt/attendance 后执行:
#   sudo bash /opt/attendance/deploy/deploy.sh
#
# 脚本会自动完成:
#   1. 安装 Node.js 20 / PostgreSQL / Nginx / PM2
#   2. 创建数据库 attendance 和专用账号（随机密码）
#   3. 安装后端依赖并生成生产环境 .env
#   4. 用 PM2 启动应用并配置开机自启
#   5. 配置 Nginx 反向代理 (80 端口 -> 3000)
# ============================================================
set -euo pipefail

APP_DIR="/opt/attendance"
APP_NAME="attendance"
DB_NAME="attendance"
DB_USER="attendance"
# 可通过环境变量覆盖: sudo DB_PASSWORD=xxx SESSION_SECRET=xxx bash deploy.sh
DB_PASSWORD="${DB_PASSWORD:-$(openssl rand -hex 16)}"
SESSION_SECRET="${SESSION_SECRET:-$(openssl rand -hex 32)}"

if [ "$(id -u)" -ne 0 ]; then
  echo "错误: 请用 sudo 运行本脚本"; exit 1
fi
if [ ! -f "$APP_DIR/server/package.json" ]; then
  echo "错误: 未找到 $APP_DIR/server/package.json"
  echo "请确认项目已上传到 /opt/attendance（目录名必须是 attendance）"; exit 1
fi

echo "==> [1/6] 安装 Node.js 20 ..."
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node -v

echo "==> [2/6] 安装 PostgreSQL 和 Nginx ..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y postgresql postgresql-contrib nginx openssl

echo "==> [3/6] 初始化数据库（账号: $DB_USER，库名: $DB_NAME）..."
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE USER $DB_USER WITH PASSWORD '$DB_PASSWORD';"
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE DATABASE $DB_NAME OWNER $DB_USER;"
# 每次运行都同步密码，保证与 .env 一致
sudo -u postgres psql -c "ALTER USER $DB_USER WITH PASSWORD '$DB_PASSWORD';"

echo "==> [4/6] 安装后端依赖并生成 .env ..."
cd "$APP_DIR/server"
npm install --omit=dev
if [ ! -f .env ]; then
  cat > .env <<EOF
PORT=3000
DB_HOST=localhost
DB_PORT=5432
DB_NAME=$DB_NAME
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASSWORD
SESSION_SECRET=$SESSION_SECRET
EOF
  chmod 600 .env
fi

echo "==> [5/6] 用 PM2 启动应用并配置开机自启 ..."
npm install -g pm2
cat > "$APP_DIR/deploy/ecosystem.config.js" <<'EOF'
module.exports = {
  apps: [{
    name: 'attendance',
    cwd: '/opt/attendance/server',
    script: 'src/index.js',
    instances: 1,
    autorestart: true,
    max_memory_restart: '400M',
    env: { NODE_ENV: 'production' }
  }]
};
EOF
cd "$APP_DIR/deploy"
pm2 delete "$APP_NAME" >/dev/null 2>&1 || true
pm2 start ecosystem.config.js
pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true
pm2 save

echo "==> [6/6] 配置 Nginx 反向代理 ..."
cp "$APP_DIR/deploy/nginx-attendance.conf" /etc/nginx/sites-available/attendance
ln -sf /etc/nginx/sites-available/attendance /etc/nginx/sites-enabled/attendance
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx
systemctl enable --now postgresql nginx

PUBLIC_IP=$(curl -s --max-time 5 ifconfig.me 2>/dev/null || echo "<服务器公网IP>")
cat <<INFO

============================================================
  部署完成！
------------------------------------------------------------
  访问地址:   http://$PUBLIC_IP
  登录入口:   http://$PUBLIC_IP/login
  数据库:     attendance / $DB_USER
  数据库密码: $DB_PASSWORD
              （已写入 /opt/attendance/server/.env，请妥善保存）
------------------------------------------------------------
  下一步: 导入本地旧数据（见 deploy/部署指南.md 第 5 步）
          并立即修改 admin 默认密码！
============================================================
INFO
