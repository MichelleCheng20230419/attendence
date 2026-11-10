# 考勤系统部署到飞牛 NAS（fnOS Docker Compose）操作说明

> 与你 xxkj 项目完全相同的部署方式。部署完成后校内任何电脑/手机浏览器访问：
> **http://172.16.4.230:8113** （xxkj 占用了 8112，考勤系统用 8113）

---

## 第 1 步：上传代码到 NAS

1. 把整个 `AttendanceSystem` 文件夹（含刚生成的 `Dockerfile`、`docker-compose.yml`、`.dockerignore`）上传到 NAS 的：
   ```
   /vol1/1000/docker/attendance
   ```
   （用 fnOS 文件管理直接拖拽上传即可；`node_modules`、`.npm-cache` 可不上传，镜像构建用不到，上传更快）

2. 上传后确认目录里有：`server/`、`public/`、`Dockerfile`、`docker-compose.yml`。

## 第 2 步：在 fnOS 创建 Compose 项目

1. 打开 **Docker → Compose → 新增项目**（和你创建 xxkj 时一样的界面）。
2. 项目名填 `attendance`，路径选择 `/vol1/1000/docker/attendance`，会自动读到 `docker-compose.yml`。
3. 点击构建/启动。首次构建会拉取 `node:20-alpine` 和 `postgres:16-alpine` 镜像并安装依赖，约 2-5 分钟。
4. 日志出现 `武汉一中管理平台服务已启动` 即成功（就是截图里那种日志弹窗）。

## 第 3 步：验证访问

浏览器打开 `http://172.16.4.230:8113/login`，默认账号 `admin / 123456`。
**⚠️ 登录后立刻修改 admin 密码。**

## 第 4 步：导入本地现有数据（可选，要把旧数据搬上去才做）

**① 在你这台 Windows 上导出数据库**（PowerShell，路径按本机 PostgreSQL 版本调整）：

```powershell
& "C:\Program Files\PostgreSQL\16\bin\pg_dump.exe" -U postgres -d testdb -F c -f "$env:USERPROFILE\Desktop\attendance_backup.dump"
```

**② 把 `attendance_backup.dump` 上传到 NAS 的 `/vol1/1000/docker/attendance/` 目录。**

**③ 在 fnOS Docker 界面给 `attendance-db` 容器打开「终端」，执行：**

```bash
pg_restore -U attendance -d attendance --no-owner --role=attendance /db-import/attendance_backup.dump
```

> 由于 compose 没有把项目目录挂进 db 容器，更省事的办法二选一：
> - **方法 A（推荐）**：先在 NAS 文件管理把 dump 放到 `/vol1/1000/docker/attendance/`，然后在 fnOS 的「Docker → 容器 → attendance-db → 终端」里执行不了文件拷贝时，可用 SSH 到 NAS 执行：
>   ```bash
>   docker cp /vol1/1000/docker/attendance/attendance_backup.dump attendance-db:/tmp/
>   docker exec attendance-db pg_restore -U attendance -d attendance --no-owner --role=attendance /tmp/attendance_backup.dump
>   ```
> - **方法 B**：导出时改用纯 SQL 格式（`-F p`），放入 `./db-init/init.sql` 并在 compose 的 db 服务增加挂载 `- ./db-init:/docker-entrypoint-initdb.d`，首次建库时自动导入（仅对空数据目录有效）。

## 日常维护

| 操作 | 位置/命令 |
|---|---|
| 启动/停止/重启 | fnOS Docker → Compose → attendance → 电源按钮 |
| 查看日志 | 项目详情 → 日志（同 xxkj） |
| 备份数据 | 直接备份 `/vol1/1000/docker/attendance/db-data` 文件夹（停机时拷贝最稳） |
| 改端口/密码 | 修改 `docker-compose.yml` 后重建项目 |

## 注意事项

- 这是**校内局域网地址**，出了校园网访问不到。如需校外访问，在 NAS 或路由器上做内网穿透（如 Tailscale、frp），或之前准备的云服务器方案仍可用。
- `db-data` 文件夹是数据库本体，**不要删除**；删除等于清空所有考勤数据。
- 想换端口：改 compose 里 `"8113:3000"` 左边的数字即可。
