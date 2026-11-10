# 武汉一中管理平台（第一版）

教师发起签到，学生通过点击卡片完成签到/请假的 Web 应用。

> 📝 **更新日志**：详细变更记录（背景/根因、改动清单、验证、数据影响）见 [`CHANGELOG.md`](CHANGELOG.md)；
> 应用内入口：右上角用户菜单 → **📝 更新日志**（`/changelog`）。

## 功能一览

| 功能 | 说明 |
|---|---|
| 发起签到 | 点击"发起签到"，设置截止时间（默认 30 分钟），自动关闭上一场次 |
| 正常签到 | 左键点击卡片 → 绿色（截止时间前） |
| 迟到 | 截止时间后左键点击 → 蓝色（自动识别） |
| 请假 | 右键点击卡片（移动端长按）→ 选择病假/事假/公假 → 橙色 |
| 缺勤 | 截止时间后未签到 → 自动标红 |
| 实时统计 | 顶部实时显示 总人数/已签到/请假/迟到/缺勤 |
| 班级信息 | 卡片显示学生所属班级（未分班显示"未分班"） |
| 添加学生 | 学生管理页"＋ 添加学生"（学号/姓名/班级，学号查重） |
| 编辑学生 | 学生管理页行内"✏️ 编辑"（姓名/班级，学号只读） |
| 删除学生 | 学生管理页行内"🗑️ 删除"（软删除，历史记录保留） |
| 学生管理页 | /students：表格 + 班级筛选 + 姓名搜索 + 分页（20条/页）+ 导入名单 + 导出考勤 |
| 导出考勤 | 时间段筛选（当天/本周/本月/本学期快捷 + 自定义），班级筛选，内容勾选；每天每生一行，无记录显示"未签到"，按日期升序 |
| 考勤分析 | /attendance-analysis：统计卡片 + 趋势/排行榜/年级对比图表（Chart.js）+ 明细表；管理员全量，教师本班，学生后续开放 |
| 签到计划 | 预置日期+时间，到点自动发起签到（支持单日/批量勾选/每周循环） |
| 手动补签 | 已结束场次可修改某学生状态 |
| 后台管理 | 管理员专属：账号列表/添加/编辑/删除/重置密码，三种角色 |
| 权限控制 | admin 全部功能；teacher 隐藏后台管理；student 只读查看签到状态 |
| 导入名单 | 点击"导入名单"：粘贴文本或上传 CSV，格式 `学号,姓名[,班级]`，学号冲突自动跳过 |
| 下载Excel | 点击"下载Excel"：导出当前场次签到情况为 .xlsx（学号/姓名/班级/状态/请假事由/签到时间） |
| 历史场次 | 每次发起签到生成独立场次，历史数据完整保留 |

状态颜色：灰=未签到，绿=已签到，橙=请假，蓝=迟到，红=缺勤。

## 技术栈

- 前端：HTML + CSS + JavaScript（单页面，无框架）
- 后端：Node.js + Express
- 数据库：PostgreSQL（testdb）

## 目录结构

```
AttendanceSystem/
├── db/
│   └── schema.sql          # 建表脚本（幂等，可重复执行）
├── server/                 # 后端
│   ├── .env                # 数据库连接配置（需填写真实密码）
│   └── src/
│       ├── index.js        # 服务入口（端口 3000，托管前端静态文件）
│       ├── db.js           # PostgreSQL 连接池
│       └── routes/
│           └── attendance.js  # 全部业务 API
└── public/                 # 前端
    ├── index.html
    ├── style.css
    └── app.js
```

## 数据库表结构

| 表名 | 说明 |
|---|---|
| `students` | 学生（含 `class_id` 班级外键） |
| `teachers` | 教师（teacher_no 工号） |
| `classes` | 班级（class_name + grade 唯一） |
| `courses` | 课程（course_code 唯一，关联教师与班级） |
| `attendance_sessions` | 签到场次 |
| `attendance_records` | 签到记录 |
| `leave_reasons` | 请假事由（病假/事假/公假） |
| `attendance_plans` | 签到计划（pending/active/ended，自动触发） |
| `users` | 账号（admin/teacher/student 三种角色） |
| `grades` | 年级（带学年属性，如 2026-2027） |
| `student_transfers` | 学生异动记录（转班/休学/复学/转学/退学） |
| `system_settings` | 系统设置（当前学年等） |

**核心设计**：年级/班级带 `academic_year` 学年属性；ID 终身不变；学生/教师账号 ID 不变，每年更新班级归属；历史签到数据按班级+学年归属，无需迁移。

## 快速开始

1. **建表**：对 `testdb` 执行 `db/schema.sql`（pgAdmin / DBeaver / psql 均可），增量迁移见 `db/migration_v2~v5.sql`
2. **配置**：复制 `server/.env.example` 为 `server/.env`，填写 `DB_PASSWORD`
   - 注意：密码含 `#` 等特殊字符时需用双引号包裹，如 `DB_PASSWORD="#abc123"`
3. **安装依赖并启动**：
   ```bash
   cd server
   npm install
   npm start        # 或 npm run dev（文件变更自动重启）
   ```
4. **访问**：浏览器打开 http://localhost:3000
   - 未登录自动跳转登录页：http://localhost:3000/login
   - **默认账号：admin / 123456**（登录后进入 /dashboard 签到页）

## 登录与会话

- 后端使用 `express-session`（Cookie 会话，7 天有效，关闭浏览器后仍保持登录）
- 账号表 `users`（角色：admin/teacher/student），密码当前为明文存储（后续改为哈希）
- 所有页面（/dashboard）与业务 API（/api/*）均需登录；未登录访问自动跳转登录页 / 返回 401
- 点击导航栏"退出登录"清除会话并返回登录页

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/students` | 学生列表（含 classId / className） |
| PUT | `/api/students/:id` | 编辑学生 `{name, classId}`（学号不可修改） |
| POST | `/api/students/import` | 批量导入 `{ students: [{studentNo, name, className?}] }`，班级按名称匹配，不存在计入 classNotFound |
| POST | `/api/attendance/start` | 发起签到 `{ deadlineMinutes?: 1~1440，默认30 }` |
| POST | `/api/attendance/checkin` | 签到 `{ studentId, action: present\|leave, leaveReason? }` |
| GET | `/api/attendance/status` | 当前场次 + 各学生记录 + 实时统计 |
| GET | `/api/attendance/export` | 导出当前场次签到情况为 .xlsx（无进行中场次时导出最近一场） |
| GET | `/api/students/export` | 按时间段导出考勤 `?startDate&endDate&classId?&fields?`（student/status/time/reason），每天每生一行 |
| GET | `/api/attendance/analysis/export` | 考勤导出（与 students/export 相同，别名） |
| GET | `/api/attendance/analysis/overview` | 统计卡片（年级/班级/时间筛选；教师强制本班） |
| GET | `/api/attendance/analysis/trend` | 出勤率趋势（按天） |
| GET | `/api/attendance/analysis/ranking` | 班级排行榜（仅管理员） |
| GET | `/api/attendance/analysis/grade-compare` | 年级对比（仅管理员） |
| GET | `/api/attendance/analysis/student-detail` | 学生出勤明细（教师/管理员，需指定班级） |
| GET | `/api/plans` | 签到计划列表（含场次截止时间） |
| POST | `/api/plans` | 添加计划（单日 `planDate` / 批量 `dates` / 周循环 `weekdays+dateFrom+dateTo`） |
| DELETE | `/api/plans/:id` | 删除计划 |
| POST | `/api/attendance/records` | 手动补签 `{sessionId, studentId, status, leaveReason?}` |
| POST | `/api/auth/login` | 登录 `{username, password}`（写入会话 Cookie） |
| POST | `/api/auth/logout` | 登出（清除会话） |
| GET | `/api/auth/me` | 当前登录用户（未登录 401） |
| GET | `/api/user/profile` | 个人资料（含班级统计/上次登录，需登录） |
| PUT | `/api/user/profile` | 更新个人资料（姓名/单位/手机/邮箱/班级） |
| POST | `/api/user/change-password` | 修改密码 `{oldPassword,newPassword,confirmPassword}` |
| GET | `/api/users` | 账号列表（仅管理员） |
| POST | `/api/users` | 添加账号 `{username,password,role,classId?,isActive?}` |
| PUT | `/api/users/:id` | 编辑账号（角色/班级/状态，用户名不可改） |
| DELETE | `/api/users/:id` | 删除账号（不能删自己/最后一个管理员） |
| POST | `/api/users/:id/reset-password` | 重置密码为 123456 |

**页面**：`/login` 登录页 · `/dashboard` 签到页 · `/profile` 个人中心 · `/admin` 后台管理（仅管理员）· `/help` 帮助文档

**自动触发**：后端每分钟检查一次 `attendance_plans`，到点自动创建 `attendance_sessions`（场次），计划状态 pending→active；场次截止后自动补缺勤并标记计划 ended。

### 签到状态说明

- 截止前 `present` → `present`（绿）；截止后 `present` → `late`（蓝）
- 截止后自动为无记录学生补 `absent`（红）
- 已标记缺勤的学生再点击：正常签到 → 转为迟到（蓝）；请假 → 转为请假（橙）
- 同一学生同一场次其他状态不可重复操作（409）

## 替换真实学生名单

方式一（推荐）：页面点击"**导入名单**"，粘贴"学号,姓名"文本或上传 CSV，实时预览后一键导入，学号重复自动跳过。

方式二：编辑 `db/schema.sql` 末尾的种子数据（`INSERT INTO students ...`），改为实际名单后重新执行（学号冲突自动跳过）。

## 常见问题

- **卡片颜色不显示**：请强制刷新（Ctrl+F5），确认标题旁版本号为最新；颜色类名映射见 `public/app.js` 的 `STATUS_CLASS`。
- **导入 CSV 乱码**：CSV 需为 UTF-8 编码（Excel 另存为 CSV 时选择"CSV UTF-8"格式）。
- **导出文件**：下载的是标准 .xlsx，可用 Excel / WPS 直接打开。
