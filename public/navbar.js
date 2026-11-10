/* ============================================================================
   顶部导航栏统一组件（全站唯一来源）
   ----------------------------------------------------------------------------
   为什么要有这个文件：
     之前只有签到操作台（index.html）有完整导航栏，其它页面各写一份"精简版"
     （只有标题 + 用户菜单），叫号管理/课堂表现/随机点名甚至没有导航栏。
     现在所有页面统一挂载同一个组件，导航栏内容与行为完全一致。

   用法（每个页面都一样，放在 body 顶部 + 脚本区顶部）：
     <header class="navbar" id="navbarHost"></header>
     ...
     <script src="/navbar.js?v=3.17.0"></script>   <!-- 必须在页面自身脚本之前 -->

   组件职责：
     · 渲染导航栏（系统标题 + 版本号 + 分组菜单 + 用户菜单）—— 唯一一份 HTML
     · 按角色显示菜单项（管理员/班主任/任课老师/班长/学生）
     · 下拉菜单交互（点击 / 悬停 / Esc / 点空白、移动端汉堡、断点收敛、当前项高亮）
     · 用户菜单（个人中心 / 帮助文档 / 更新日志〔仅管理员〕/ 退出登录）
     · 菜单跳转（按 data-path）；当前页交互由页面脚本监听 `navbar:item` 事件处理
     · 班长端叫号角标（非签到操作台页面自行轮询，签到台由 app.js 驱动）

   对外接口：
     window.DSH_APP_VERSION            版本号（页面脚本共用，避免多处硬编码）
     window.DSHNavbar.user / role      当前登录用户与角色
     window.DSHNavbar.ready            角色过滤完成后的 Promise
     window.DSHNavbar.setAnnBadge(n)   设置叫号角标（0 隐藏）
     window.DSHNavbar.isMonitor etc.   角色判定
     window.__nav                      测试钩子（与旧版一致）
   事件：
     window 'navbar:item' { detail: { id } }   点击"当前页"菜单项（如签到台上的计划管理）
   ============================================================================ */
(function () {
  'use strict';

  const APP_VERSION = '3.16.0';
  window.DSH_APP_VERSION = APP_VERSION;

  const NAV_MOBILE_MAX = 1024;     // 与 style.css 断点一致
  const NAV_CLOSE_DELAY = 200;     // 鼠标离开后延迟关闭（给"按钮 → 菜单"移动留时间）
  const BADGE_POLL_MS = 30000;     // 班长端叫号角标轮询间隔（非签到操作台页面）

  // ---------- 导航栏 HTML（全站唯一一份；id/class 与旧版 index.html 完全一致） ----------
  const NAV_INNER_HTML = `
    <div class="navbar-inner">
      <div class="navbar-left">
        <h1 class="app-title">📋 武汉一中管理平台 <span id="verTag" class="ver-tag">v${APP_VERSION}</span></h1>
      </div>

      <button id="navToggle" class="nav-toggle" aria-expanded="false" aria-controls="navbarMenus" title="展开菜单">☰ 菜单</button>

      <!-- 分组导航：签到操作｜考勤管理▾｜教学工具▾｜数据统计▾｜系统管理▾（按角色动态显示）
           班长：签到操作 + 叫号提醒 + 随机点名 + 👍 点赞排行（后三项由脚本上提到顶层） -->
      <nav class="navbar-actions" id="navbarMenus" aria-label="功能导航">
        <button id="navAttendance" class="nav-item" data-path="/dashboard" title="签到操作台（首页）">🖥 签到操作</button>

        <!-- 巡堂记录（新模块）：默认隐藏，由"小组权限"授权后显示（管理员固定可见） -->
        <button id="navInspection" class="nav-item hidden" data-path="/inspection" title="巡堂记录（小组授权可见）">🧭 巡堂记录</button>

        <!-- 点赞排行榜：仅班长端可见（本班只读排行）；老师/班主任/管理员走"课堂表现"面板 -->
        <button id="navLikesRanking" class="nav-item hidden" data-path="/likes-ranking" title="点赞排行榜（本班，只读）">👍 点赞排行</button>

        <div class="nav-group hidden" id="navGroupAttendance">
          <button id="navAttendanceMgmt" class="nav-item" aria-haspopup="true" aria-expanded="false" aria-controls="navAttendanceMenu">考勤管理 <span class="nav-caret">▾</span></button>
          <div class="nav-dropdown hidden" id="navAttendanceMenu" role="menu">
            <div class="nav-dropdown-card">
              <button class="nav-dropdown-item hidden" id="btnPlansView" data-path="#plans" role="menuitem" title="管理签到计划">📅 计划管理</button>
              <button class="nav-dropdown-item hidden" id="btnStudents" data-path="/students" role="menuitem" title="学生管理">👨‍🎓 学生管理</button>
            </div>
          </div>
        </div>

        <div class="nav-group hidden" id="navGroupTeaching">
          <button id="navTeaching" class="nav-item" aria-haspopup="true" aria-expanded="false" aria-controls="navTeachingMenu">教学工具 <span class="nav-caret">▾</span></button>
          <div class="nav-dropdown hidden" id="navTeachingMenu" role="menu">
            <div class="nav-dropdown-card">
              <button class="nav-dropdown-item hidden" id="btnAnnManage" data-path="/announcements" role="menuitem" title="叫号管理（发布叫号 / 查看列表）">📢 叫号管理</button>
              <button class="nav-dropdown-item hidden" id="btnRollCall" data-path="/random-call" role="menuitem" title="随机点名（独立页面，适合教室大屏）">🎲 随机点名</button>
              <button class="nav-dropdown-item hidden" id="btnHomeworkManage" data-path="/homework-manage" role="menuitem" title="作业管理（发布作业 / 我的作业）">📚 作业管理</button>
              <button class="nav-dropdown-item hidden" id="btnAnnouncements" data-path="#ann" role="menuitem" title="叫号提醒（老师发布的叫号通知）">📢 叫号提醒<span id="annBadge" class="ann-badge hidden">0</span></button>
            </div>
          </div>
        </div>

        <div class="nav-group hidden" id="navGroupStats">
          <button id="navStats" class="nav-item" aria-haspopup="true" aria-expanded="false" aria-controls="navStatsMenu">数据统计 <span class="nav-caret">▾</span></button>
          <div class="nav-dropdown hidden" id="navStatsMenu" role="menu">
            <div class="nav-dropdown-card">
              <button class="nav-dropdown-item hidden" id="btnHomework" data-path="/homework" role="menuitem" title="作业统计（本班 / 本学科）">📝 作业统计</button>
              <button class="nav-dropdown-item hidden" id="btnPerformance" data-path="/performance" role="menuitem" title="课堂表现（点名记录 + 点赞数据）">📊 课堂表现</button>
              <button class="nav-dropdown-item hidden" id="btnAnalysis" data-path="/attendance-analysis" role="menuitem" title="考勤分析">📈 考勤分析</button>
              <!-- 巡查面板：巡堂数据整体统计（与"巡堂记录"同为小组授权项，仅教务组可见） -->
              <button class="nav-dropdown-item hidden" id="btnInspectionPanel" data-path="/inspection/panel" role="menuitem" title="巡查面板（巡堂数据统计，需小组授权）">📊 巡查面板</button>
            </div>
          </div>
        </div>

        <div class="nav-group hidden" id="navGroupSystem">
          <button id="navSystem" class="nav-item" aria-haspopup="true" aria-expanded="false" aria-controls="navSystemMenu">系统管理 <span class="nav-caret">▾</span></button>
          <div class="nav-dropdown hidden" id="navSystemMenu" role="menu">
            <div class="nav-dropdown-card">
              <button class="nav-dropdown-item hidden" id="btnAdminUsers" data-path="/admin/account-management" role="menuitem" title="账号管理（独立页面）">👤 账号管理</button>
              <button class="nav-dropdown-item hidden" id="btnAdminGrades" data-path="/admin/grade-management" role="menuitem" title="年级管理（独立页面）">🏫 年级管理</button>
              <button class="nav-dropdown-item hidden" id="btnAdminClasses" data-path="/admin/class-management" role="menuitem" title="班级管理（独立页面）">🏛 班级管理</button>
              <button class="nav-dropdown-item hidden" id="btnAdminYears" data-path="/admin/academic-year-management" role="menuitem" title="学年管理（独立页面）">📆 学年管理</button>
              <button class="nav-dropdown-item hidden" id="btnAdminGroups" data-path="/admin/group-management" role="menuitem" title="小组管理（自定义权限配置）">👥 小组管理</button>
            </div>
          </div>
        </div>
      </nav>

      <div class="user-menu">
        <button id="btnUser" class="btn user-btn" title="个人中心">👤 <span id="userInfo">--</span> ▾</button>
        <div id="userDropdown" class="user-dropdown hidden">
          <div class="user-dropdown-item" id="menuProfile">👤 个人中心</div>
          <div class="user-dropdown-item" id="menuHelp">📖 帮助文档</div>
          <div class="user-dropdown-item hidden" id="menuChangelog">📝 更新日志</div>
          <div class="user-dropdown-divider"></div>
          <div class="user-dropdown-item danger" id="menuLogout">🚪 退出登录</div>
        </div>
      </div>
    </div>`;

  // ---------- 角色矩阵（与需求表一致；仅导航栏条目） ----------
  const NAV_ITEM_RULES = {
    btnPlansView: (r) => r.isTeacher || r.isAdmin,
    btnStudents: (r) => r.isTeacher || r.isAdmin,
    btnAnnManage: (r) => r.isTeacher || r.isAdmin,
    btnRollCall: (r) => r.isMonitor || r.isTeacher || r.isAdmin,
    btnHomeworkManage: (r) => r.isTeacher || r.isAdmin,
    btnAnnouncements: (r) => r.isMonitor,
    btnHomework: (r) => r.isMonitor || r.isTeacher || r.isAdmin,   // 班长端在顶层看到「作业统计」；教师/管理员在「数据统计」下拉里
    btnPerformance: (r) => r.isTeacher || r.isAdmin,
    btnAnalysis: (r) => r.isTeacher || r.isAdmin,
    btnInspectionPanel: () => false,   // 巡查面板：仅由小组权限 inspection 授权（管理员走 permissions.all）
    // 📝 更新日志：仅管理员可见（/changelog 路由本身也只放行管理员）
    menuChangelog: (r) => r.isAdmin,
    // 👍 点赞排行榜：仅班长端（老师/班主任/管理员用"课堂表现"里的点赞排行，不再单独给菜单）
    navLikesRanking: (r) => r.isMonitor,
    btnAdminUsers: (r) => r.isAdmin,
    btnAdminGrades: (r) => r.isAdmin,
    btnAdminClasses: (r) => r.isAdmin,
    btnAdminYears: (r) => r.isAdmin,
    btnAdminGroups: (r) => r.isAdmin,
  };

  // 角色强制隐藏的分组（即使组内有可见条目也整组隐藏）
  const ROLE_HIDDEN_GROUPS = {
    student: ['navGroupAttendance', 'navGroupTeaching', 'navGroupStats', 'navGroupSystem'],
    teacher: [],
    monitor: ['navGroupAttendance', 'navGroupTeaching', 'navGroupStats', 'navGroupSystem'],
  };

  // 小组权限（page key）→ 导航元素：授权后把这些菜单显示出来（叠加在角色菜单之上）
  const PAGE_NAV = {
    attendance_management: { group: 'navGroupAttendance', items: ['btnPlansView', 'btnStudents'] },
    teaching_tools: { group: 'navGroupTeaching', items: ['btnAnnManage', 'btnRollCall', 'btnHomeworkManage'] },
    data_stats: { group: 'navGroupStats', items: ['btnHomework', 'btnPerformance', 'btnAnalysis'] },
    inspection: { group: 'navGroupStats', items: ['navInspection', 'btnInspectionPanel'] },
    // 系统管理不通过小组授予（仅管理员）
  };
  const GROUP_OF_PAGE = {
    navGroupAttendance: 'attendance_management',
    navGroupTeaching: 'teaching_tools',
    navGroupStats: 'data_stats',
    navGroupSystem: 'system_management',
  };
  // 某些分组除了自身页面权限外，还允许被"其它页面权限"点亮（用于把小组授权项放进合适的分组）
  const GROUP_ALT_PAGES = {
    navGroupStats: ['inspection'],   // 巡查面板（inspection）放在"数据统计"分组里
  };

  const $ = (id) => document.getElementById(id);
  const qs = (sel) => document.querySelector(sel);
  const qsa = (sel) => Array.prototype.slice.call(document.querySelectorAll(sel));

  const state = {
    mounted: false,
    user: null,
    role: null,
    isAdmin: false,
    isTeacher: false,
    isMonitor: false,
    isHeadTeacher: false,
    groups: [],
    permissions: { pages: [], actions: [], all: false },
    badgeTimer: null,
  };

  let navCloseTimer = null;

  function cancelNavClose() { if (navCloseTimer) { clearTimeout(navCloseTimer); navCloseTimer = null; } }
  function scheduleNavClose() {
    cancelNavClose();
    navCloseTimer = setTimeout(() => { navCloseTimer = null; closeNavMenus(); }, NAV_CLOSE_DELAY);
  }

  function navGroups() { return qsa('.nav-group'); }

  function closeNavMenus() {
    cancelNavClose();
    navGroups().forEach((g) => {
      g.classList.remove('open');
      const btn = g.querySelector('.nav-item');
      const menu = g.querySelector('.nav-dropdown');
      if (btn) { btn.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); }
      if (menu) menu.classList.add('hidden');
    });
  }

  function openNavMenu(group) {
    const btn = group.querySelector('.nav-item');
    const menu = group.querySelector('.nav-dropdown');
    if (!menu) return;
    group.classList.add('open');
    menu.classList.remove('hidden');
    if (btn) { btn.classList.add('open'); btn.setAttribute('aria-expanded', 'true'); }
    // 定位：默认与触发按钮左对齐；若右边缘超出视口则翻转为右对齐（避免溢出屏幕）
    menu.style.left = '0';
    menu.style.right = 'auto';
    if (window.innerWidth > NAV_MOBILE_MAX) {
      const card = menu.querySelector('.nav-dropdown-card') || menu;
      const rect = card.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      if (rect.right > vw - 8) { menu.style.left = 'auto'; menu.style.right = '0'; }
    }
  }

  function toggleMobileNav(force) {
    const menus = $('navbarMenus');
    const toggle = $('navToggle');
    if (!menus || !toggle) return;
    const wasOpen = menus.classList.contains('open');
    const open = force !== undefined ? force : !wasOpen;
    toggle.setAttribute('aria-expanded', String(open));
    toggle.textContent = open ? '✕ 关闭' : '☰ 菜单';
    // 状态没变就什么都不做：断点事件（matchMedia change）可能晚于用户操作到达，
    // 若此处无条件 closeNavMenus()，会把刚展开的下拉菜单误关掉
    if (open === wasOpen) return;
    menus.classList.toggle('open', open);
    if (!open) closeNavMenus();
  }

  function displayNameForNav(u) {
    const nm = (u && (u.realName || u.displayName || u.username)) || '';
    if (u && u.role === 'teacher') return `${nm}（教师）`;
    if (u && u.role === 'monitor') return `${nm}（班长）`;
    if (u && u.role === 'student') return `${nm}（学生）`;
    return nm;
  }

  function roleFlags(user) {
    const roles = (user && user.roles) || [];
    const headClassIds = (user && user.headClassIds) || [];
    const role = (user && user.role) || '';
    return {
      role,
      isAdmin: role === 'admin',
      isTeacher: role === 'teacher',
      isMonitor: role === 'monitor',
      isHeadTeacher: role === 'teacher' && (roles.includes('head_teacher') || headClassIds.length > 0),
    };
  }

  // 顶层导航排列（需求 2026-09-30）：
  //   · **班长**：「📝 作业统计」提到顶层，紧跟"🖥 签到操作" → 顺序 = 签到操作 | 作业统计 | 叫号提醒 | 随机点名 | 点赞排行
  //   · **班主任 / 任课老师 / 管理员**：导航栏**保持不变**（作业统计仍在「数据统计」下拉里）
  function arrangeTopLevelNav() {
    const menus = $('navbarMenus');
    if (!menus) return;
    const statsCard = qs('#navStatsMenu .nav-dropdown-card');
    const teachCard = qs('#navTeachingMenu .nav-dropdown-card');
    const homework = $('btnHomework');
    const toTop = (node, after) => {
      if (!node) return null;
      if (node.parentElement !== menus && after) after.insertAdjacentElement('afterend', node);
      node.classList.remove('nav-dropdown-item');
      node.classList.add('nav-item');
      node.removeAttribute('role');
      return node;
    };
    const backTo = (node, card) => {
      if (!node || !card || node.parentElement === card) return;
      card.appendChild(node);
      node.classList.remove('nav-item');
      node.classList.add('nav-dropdown-item');
      node.setAttribute('role', 'menuitem');
    };
    if (state.isMonitor) {
      let anchor = toTop(homework, $('navAttendance')) || $('navAttendance');
      anchor = toTop($('btnAnnouncements'), anchor) || anchor;
      anchor = toTop($('btnRollCall'), anchor) || anchor;
    } else {
      // 教师/管理员：作业统计留在「数据统计」下拉（位置不变），叫号提醒/随机点名留在各自下拉
      backTo(homework, statsCard);
      backTo($('btnAnnouncements'), teachCard);
      backTo($('btnRollCall'), teachCard);
    }
  }

  // 按角色过滤菜单项与分组；随后叠加"小组授权"（小组权限只增不减）
  function applyRoleUI() {
    const hiddenGroups = ROLE_HIDDEN_GROUPS[state.role] || [];
    Object.keys(NAV_ITEM_RULES).forEach((id) => {
      const node = $(id);
      if (node) node.classList.toggle('hidden', !NAV_ITEM_RULES[id](state));
    });
    // 顶层导航排列：作业统计 / 叫号提醒 / 随机点名（顺序见 arrangeTopLevelNav 注释）
    arrangeTopLevelNav();
    // 小组权限：管理员拥有全部权限；普通用户按所属小组权限并集显示菜单
    applyGroupPermissions(state.permissions);

    ['navGroupAttendance', 'navGroupTeaching', 'navGroupStats', 'navGroupSystem'].forEach((gid) => {
      const g = $(gid);
      if (!g) return;
      const perms = state.permissions || {};
      const pages = perms.pages || [];
      const keys = [GROUP_OF_PAGE[gid]].concat(GROUP_ALT_PAGES[gid] || []);
      const grantedByGroup = perms.all === true || keys.some((k) => k && pages.indexOf(k) >= 0);
      // 角色禁止该分组、且小组也没有授权 → 整组隐藏
      if (hiddenGroups.indexOf(gid) >= 0 && !grantedByGroup) { g.classList.add('hidden'); return; }
      const anyVisible = Array.prototype.slice.call(g.querySelectorAll('.nav-dropdown-item'))
        .some((i) => !i.classList.contains('hidden'));
      g.classList.toggle('hidden', !anyVisible);
    });

    if (state.isMonitor) startBadgePolling();
  }

  // 小组权限 → 菜单：pages 里的页面 key 对应哪些菜单项/分组（叠加显示）
  function applyGroupPermissions(permissions) {
    const pages = (permissions && permissions.pages) || [];
    Object.keys(PAGE_NAV).forEach((key) => {
      const granted = permissions && permissions.all ? true : pages.indexOf(key) >= 0;
      if (!granted) return;
      const cfg = PAGE_NAV[key];
      (cfg.items || []).forEach((id) => { const n = $(id); if (n) n.classList.remove('hidden'); });
    });
  }

  // 当前页高亮（按 data-path 匹配路径；/dashboard → 签到操作）
  function markActiveNav() {
    const here = window.location.pathname;
    qsa('[data-path]').forEach((node) => {
      const p = node.dataset.path;
      if (!p || p.charAt(0) === '#') return;
      const on = p === here;
      node.classList.toggle('active', on);
      if (on) {
        const group = node.closest('.nav-group');
        const gbtn = group && group.querySelector('.nav-item');
        if (gbtn) gbtn.classList.add('active');
      }
    });
    const navAttendance = $('navAttendance');
    if (here === '/dashboard' && navAttendance) navAttendance.classList.add('active');
  }

  function setAnnBadge(count) {
    const el = $('annBadge');
    if (!el) return;
    const n = Number(count) || 0;
    el.textContent = n > 99 ? '99+' : String(n);
    el.classList.toggle('hidden', n === 0);
  }

  // ---------- 班长端「叫号提醒」**全局**轮询 + 语音播报（2026-09-30 架构修复） ----------
  //   为什么改：播报逻辑原来写在 app.js 里，而 app.js **只在签到操作台加载** →
  //   班长切到其它页面（随机点名 / 课堂表现 / 点赞排行 / 作业管理…）就收不到播报，必须手动点「叫号提醒」。
  //   现在放到 navbar.js（每个页面都加载）：
  //     · 班长登录后（任意页面）每 30 秒轮询一次 /api/announcements/inbox
  //     · 发现 is_played=false 的新叫号 → 语音播报 → POST /api/announcements/:id/played 标记已播报（同一叫号不重复播）
  //     · 角标同步更新；「叫号提醒」手动查看（签到操作台的弹窗）保持原样
  // 需求（2026-09-30 反馈）：**10 秒**轮询一次，老师发布后班长端 ≤10 秒自动播报，无需手动刷新
  const ANN_POLL_MS = 10000;
  function annSpeechText(a) {
    const cls = a.className || '本班';
    const name = a.studentName || '同学';
    const loc = a.location || '';
    return `请${cls}${name}到${loc}`;
  }
  function annSpeak(a) {
    const text = annSpeechText(a);
    window.__lastSpoken = text;                 // 测试钩子（无声音环境也能断言播报内容）
    try {
      if (typeof window.speechSynthesis === 'undefined') return false;
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-CN'; u.rate = 1; u.volume = 1; u.pitch = 1;
      window.__lastSpokenOpts = { lang: u.lang, rate: u.rate, volume: u.volume };
      window.speechSynthesis.speak(u);
      return true;
    } catch (_) { return false; }
  }
  async function annSpeakUnplayed(list) {
    const pending = (list || []).filter((a) => !a.isPlayed);
    if (pending.length === 0) return 0;
    pending.sort((x, y) => {
      const ux = x.priority === 'urgent' ? 0 : 1;
      const uy = y.priority === 'urgent' ? 0 : 1;
      if (ux !== uy) return ux - uy;
      return new Date(x.createdAt) - new Date(y.createdAt);
    });
    for (const a of pending) {
      annSpeak(a);
      try {
        await fetch(`/api/announcements/${a.id}/played`, { method: 'POST', credentials: 'same-origin' });
      } catch (_) {}
      a.isPlayed = true;
    }
    return pending.length;
  }
  async function annPollOnce() {
    if (state.annBusy) return;
    state.annBusy = true;
    try {
      const res = await fetch('/api/announcements/inbox', { credentials: 'same-origin' });
      if (!res.ok) return;
      const data = await res.json();
      state.annData = data;
      state.annPollCount = (state.annPollCount || 0) + 1;
      setAnnBadge(data.pendingCount);
      const n = await annSpeakUnplayed(data.unplayed);
      if (n > 0) {
        setAnnBadge(Math.max(0, Number(data.pendingCount) || 0));
        window.__annSpokenCount = (window.__annSpokenCount || 0) + n;   // 测试钩子：累计已播报条数
      }
      // 让页面脚本（签到操作台的叫号弹窗）复用同一份数据，避免重复拉取/重复播报
      try { window.dispatchEvent(new CustomEvent('dsh:announcements', { detail: data })); } catch (_) {}
    } catch (_) {} finally { state.annBusy = false; }
  }
  // 班长端角标 + 全局播报：**所有页面**（含签到操作台）统一由本组件负责
  //   · 每 10 秒轮询一次（ANN_POLL_MS）；进页面立刻轮询一次
  //   · 浏览器会**在后台标签页节流 setInterval**（可能被拖到 1 分钟以上）→ 切回前台/窗口聚焦时立刻补一次，
  //     否则"老师刚发布、班长切回来却要等很久才播报"（就是本轮反馈的"必须手动刷新"）
  function startBadgePolling() {
    if (state.badgeTimer) return;
    annPollOnce();
    state.badgeTimer = setInterval(() => { annPollOnce(); }, ANN_POLL_MS);
    const recheck = () => {
      if (document.visibilityState === 'visible') annPollOnce();
    };
    document.addEventListener('visibilitychange', recheck);
    window.addEventListener('focus', recheck);
    window.addEventListener('online', recheck);
  }
  // 供其它脚本复用（签到操作台弹窗）：数据读取 + 手动播报一条
  const annApi = {
    get data() { return state.annData; },
    get pollCount() { return state.annPollCount || 0; },
    refresh: annPollOnce,
    speak: annSpeak,
    speakText: annSpeechText,
    pollMs: ANN_POLL_MS,
  };

  // ---------- 菜单点击：统一按 data-path 跳转 ----------
  // 当前页自身可响应的项（计划管理 / 叫号提醒）→ 派发事件给页面脚本，避免整页刷新
  function targetOf(id, dataPath) {
    if (dataPath === '#plans') return '/dashboard?view=plans';
    if (dataPath === '#ann') return '/dashboard?ann=1';
    return dataPath || '';
  }

  function onNavItemClick(id, dataPath, ev) {
    if (ev) ev.preventDefault();
    const target = targetOf(id, dataPath);
    const here = window.location.pathname;
    if (!target) { closeNavMenus(); return; }
    if (target === here) {                       // 已在目标页：交给页面脚本处理（如切换视图/开弹窗）
      closeNavMenus();
      window.dispatchEvent(new CustomEvent('navbar:item', { detail: { id } }));
      return;
    }
    if (here === '/dashboard' && (id === 'btnPlansView' || id === 'btnAnnouncements')) {
      closeNavMenus();                            // 签到操作台内：直接切视图 / 开弹窗，不刷新
      window.dispatchEvent(new CustomEvent('navbar:item', { detail: { id } }));
      return;
    }
    window.location.href = target;
  }

  function bindInteractions(host) {
    // 一级菜单：点击展开/收起
    navGroups().forEach((g) => {
      const btn = g.querySelector('.nav-item');
      const menu = g.querySelector('.nav-dropdown');
      if (!btn || !menu) return;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const wasOpen = g.classList.contains('open');
        closeNavMenus();
        if (!wasOpen) openNavMenu(g);
      });
      // 桌面悬停展开；离开整个"按钮+菜单"区域后延迟关闭
      g.addEventListener('mouseenter', () => {
        if (window.innerWidth > NAV_MOBILE_MAX) {
          cancelNavClose();
          if (!g.classList.contains('open')) { closeNavMenus(); openNavMenu(g); }
        }
      });
      g.addEventListener('mouseleave', () => {
        if (window.innerWidth > NAV_MOBILE_MAX) scheduleNavClose();
      });
      // 点击菜单项后收起（跳转前先收，避免残留；移动端连同汉堡面板一起收起）
      menu.addEventListener('click', () => {
        closeNavMenus();
        if (window.innerWidth <= NAV_MOBILE_MAX) toggleMobileNav(false);
      });
    });

    // 菜单项跳转（统一处理，页面脚本无需再为导航项绑定跳转）
    host.addEventListener('click', (e) => {
      const item = e.target.closest ? e.target.closest('.nav-item, .nav-dropdown-item') : null;
      if (!item) return;
      if (item.classList.contains('nav-dropdown-item') && item.closest('.nav-dropdown') === null) return;
      // 一级分组触发按钮（考勤管理▾ 等）不参与跳转
      if (item.classList.contains('nav-item') && item.closest('.nav-group')) return;
      onNavItemClick(item.id, item.dataset.path, e);
    });

    // 点击空白处 / Esc：收起下拉与汉堡菜单
    document.addEventListener('click', (e) => {
      if (!e.target.closest || !e.target.closest('.nav-group')) closeNavMenus();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closeNavMenus(); toggleMobileNav(false); }
    });
    // 断点监听：用 matchMedia，仅在真正跨越 1024px 断点时收敛形态
    const navMq = window.matchMedia(`(max-width: ${NAV_MOBILE_MAX}px)`);
    if (navMq.addEventListener) navMq.addEventListener('change', () => toggleMobileNav(false));
    else if (navMq.addListener) navMq.addListener(() => toggleMobileNav(false));

    const toggle = $('navToggle');
    if (toggle) toggle.addEventListener('click', (e) => { e.stopPropagation(); toggleMobileNav(); });
  }

  function bindUserMenu() {
    const btnUser = $('btnUser');
    const dropdown = $('userDropdown');
    if (!btnUser || !dropdown) return;
    const toggleDropdown = (show) => dropdown.classList.toggle('hidden', !show);
    btnUser.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleDropdown(dropdown.classList.contains('hidden'));
    });
    document.addEventListener('click', () => toggleDropdown(false));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggleDropdown(false); });

    const profile = $('menuProfile');
    if (profile) profile.addEventListener('click', () => { toggleDropdown(false); window.location.href = '/profile'; });
    const help = $('menuHelp');
    if (help) help.addEventListener('click', () => { toggleDropdown(false); window.open('/help', '_blank'); });
    // 更新日志（CHANGELOG.md，应用内以纯文本打开）
    const changelog = $('menuChangelog');
    if (changelog) changelog.addEventListener('click', () => { toggleDropdown(false); window.open('/changelog', '_blank'); });
    const logout = $('menuLogout');
    if (logout) logout.addEventListener('click', async () => {
      toggleDropdown(false);
      try {
        await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
      } catch (_) {}
      window.location.href = '/login';
    });
  }

  async function loadMe() {
    try {
      const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
      if (!res.ok) { if (res.status === 401) window.location.href = '/login'; return null; }
      const data = await res.json();
      return data.user || null;
    } catch (_) { return null; }
  }

  function mount(hostSel) {
    const host = typeof hostSel === 'string' ? qs(hostSel) : (hostSel || $('navbarHost') || qs('.navbar'));
    if (!host) return null;
    if (!host.classList.contains('navbar')) host.classList.add('navbar');
    if (!host.id) host.id = 'navbarHost';
    if (host.dataset.navMounted === '1') return host;   // 幂等
    host.dataset.navMounted = '1';
    host.innerHTML = NAV_INNER_HTML;

    bindInteractions(host);
    bindUserMenu();
    markActiveNav();
    state.mounted = true;

    // 供测试断言使用（与旧版 app.js 的 window.__nav 完全一致）
    window.__nav = {
      closeAll: closeNavMenus,
      openGroup: (id) => { const g = $(id); if (g) openNavMenu(g); },
      toggleMobile: toggleMobileNav,
      closeDelayMs: NAV_CLOSE_DELAY,
      openGroups: () => navGroups().filter((g) => g.classList.contains('open')).map((g) => g.id),
      visibleItems: () => qsa('.nav-dropdown-item')
        .filter((i) => !i.classList.contains('hidden') && !i.closest('.nav-group').classList.contains('hidden'))
        .map((i) => i.id),
      groups: () => navGroups().filter((g) => !g.classList.contains('hidden')).map((g) => g.id),
      activeItems: () => qsa('.nav-item.active').map((n) => n.id),
      version: APP_VERSION,
    };

    // 角色过滤（异步：拿当前登录用户 + 小组权限）
    const p = (async () => {
      const user = await loadMe();
      state.user = user;
      const flags = roleFlags(user);
      Object.assign(state, flags);
      state.groups = (user && user.groups) || [];
      state.permissions = (user && user.permissions) || { pages: [], actions: [], all: false };
      const info = $('userInfo');
      if (info && user) info.textContent = displayNameForNav(user);
      applyRoleUI();
      markActiveNav();
      return user;
    })();

    return { host, ready: p };
  }

  window.DSHNavbar = {
    APP_VERSION,
    mount,
    setAnnBadge,
    ready: null,
    get user() { return state.user; },
    get role() { return state.role; },
    get isAdmin() { return state.isAdmin; },
    get isTeacher() { return state.isTeacher; },
    get isMonitor() { return state.isMonitor; },
    // 叫号（全局轮询 + 播报）对外接口：签到操作台的弹窗复用它，避免两处各播一遍
    announcements: annApi,
    get isHeadTeacher() { return state.isHeadTeacher; },
    get groups() { return state.groups; },
    get permissions() { return state.permissions; },
    hasPage: (key) => state.permissions && (state.permissions.all === true || (state.permissions.pages || []).indexOf(key) >= 0),
    hasAction: (key) => state.permissions && (state.permissions.all === true || (state.permissions.actions || []).indexOf(key) >= 0),
  };

  // 自动挂载：页面里写了 <header class="navbar" id="navbarHost"></header> 即可。
  // 必须"同步"挂载（脚本位于 body 末尾、host 在其上方）：页面脚本会在解析时
  // 立刻查找 #btnUser / #navbarMenus 等元素，晚一步就会拿到 null。
  function autoMount() {
    const host = $('navbarHost') || qs('header.navbar');
    if (!host) return false;
    const r = mount(host);
    if (r && r.ready) window.DSHNavbar.ready = r.ready;
    window.dispatchEvent(new CustomEvent('navbar:mounted', { detail: { version: APP_VERSION } }));
    return true;
  }

  if (!autoMount()) {
    // 极端情况（脚本被放到 head 等）：等 DOM 就绪后再挂载
    document.addEventListener('DOMContentLoaded', () => { autoMount(); });
  }
})();
