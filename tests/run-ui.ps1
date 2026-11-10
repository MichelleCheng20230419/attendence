<#
  UI 驱动统一运行脚本（无头 Chrome）
  ------------------------------------------------------------------
  为什么需要它：
    1) 管理员的登录密码可能被改（库里 password 字段是当前值），驱动里默认写死 123456；
       本脚本在"复制到 public/ 运行时"把密码替换成实际值（可用 -AdminPw 或环境变量 DSH_ADMIN_PW）
       —— 仓库里的 tests/*.html 保持默认值不变，不写入真实密码。
    2) 巡堂问题没有删除接口，驱动只能打印 ISSUES=<id,...>；本脚本跑完自动按该行清理夹具问题。
    3) 驱动产物（public/_<name>.html、.tmp_<name>.html）由本脚本自动删除。

  用法：
    # 单个驱动（密码取环境变量 DSH_ADMIN_PW，缺省 123456）
    .\tests\run-ui.ps1 -Name ui_likes_ranking -AdminPw '#include123'
    # 多个驱动
    .\tests\run-ui.ps1 -Name ui_inspection,ui_likes_ranking -AdminPw '#include123'
    # 全部驱动（耗时较长；ui_session_audit 放最后，会打印 SESSIONS=<id> 并自动清理）
    .\tests\run-ui.ps1 -All -AdminPw '#include123'

  前置：服务已启动（默认 http://localhost:3000）；psql 路径见 $Psql。
#>
param(
  [string[]]$Name = @(),
  [switch]$All,
  [string]$AdminPw = $env:DSH_ADMIN_PW,
  [string]$Base = 'http://localhost:3000',
  [int]$Budget = 400000,
  [string]$Psql = 'D:\Program Files (x86)\PostgreSQL17\bin\psql.exe',
  [string]$Db = 'testdb',
  [string]$DbUser = 'postgres',
  [string]$DbPw = '#include123'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $AdminPw) { $AdminPw = '123456' }

if ($All) {
  # session_audit 会留下进行中场次 → 放最后
  $Name = Get-ChildItem (Join-Path $PSScriptRoot 'ui_*.html') |
    ForEach-Object { $_.BaseName } |
    Where-Object { $_ -ne 'ui_session_audit' } |
    Sort-Object
  $Name += 'ui_session_audit'
}
if (-not $Name -or $Name.Count -eq 0) { throw '请用 -Name <驱动名>（如 ui_likes_ranking）或 -All' }

function Invoke-Sql([string]$sql) {
  $tmp = Join-Path $root 'db\.tmp_runui.sql'
  [System.IO.File]::WriteAllText($tmp, $sql, (New-Object System.Text.UTF8Encoding($false)))
  $env:PGPASSWORD = $DbPw
  & $Psql -U $DbUser -h localhost -d $Db -q -f $tmp 2>&1 | Out-Null
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
}

function Get-ScalarValue([string]$sql) {
  $q = Join-Path $root 'db\.tmp_runui_q.sql'
  [System.IO.File]::WriteAllText($q, "SET client_encoding='UTF8';`n" + $sql, (New-Object System.Text.UTF8Encoding($false)))
  $env:PGPASSWORD = $DbPw
  $out = & $Psql -U $DbUser -h localhost -d $Db -t -A -f $q 2>&1
  Remove-Item $q -Force -ErrorAction SilentlyContinue
  return (($out | Where-Object { $_ -match '^\d+$' } | Select-Object -First 1))
}

# 数据完整性看门狗：每个驱动跑之前先记一份"历史数据指纹"（场次/记录/计划/关联行总量 + 最大 id）
#   原因：驱动里的"夹具清理"一旦条件写错，会误删真实历史数据（2026-09-29 发生过一次：
#   某驱动用 `.filter(x => x.classId === created.classId)` 兜底，夹具班级创建失败时
#   classId 为空 → 匹配到所有"全校计划" → 把关联的真实历史场次一起删了）。
#   本看门狗只读、只报警，绝不改数据。
function Get-Watchdog {
  return @{
    sess    = Get-ScalarValue 'SELECT count(*) FROM attendance_sessions;'
    recs    = Get-ScalarValue 'SELECT count(*) FROM attendance_records;'
    plans   = Get-ScalarValue 'SELECT count(*) FROM attendance_plans;'
    links   = Get-ScalarValue 'SELECT count(*) FROM attendance_plan_sessions;'
    maxSess = Get-ScalarValue 'SELECT COALESCE(max(id),0) FROM attendance_sessions;'
    maxPlan = Get-ScalarValue 'SELECT COALESCE(max(id),0) FROM attendance_plans;'
    users   = Get-ScalarValue 'SELECT count(*) FROM users;'
    students = Get-ScalarValue 'SELECT count(*) FROM students;'
  }
}

foreach ($n in $Name) {
  $src = Join-Path $PSScriptRoot "$n.html"
  if (-not (Test-Path $src)) { "跳过：找不到 $src"; continue }
  $wdBefore = Get-Watchdog
  $pub = Join-Path $root "public\_$n.html"
  $outFile = Join-Path $root ".tmp_$n.html"
  # 复制到 public/ 并把登录密码替换为实际值（仓库文件不变）
  #   两种写法都要替换，否则"夹具账号用一套、登录用另一套"会 401：
  #     body: { username: 'admin', password: '123456' }
  #     async function asUser(u, p = '123456')
  $html = [System.IO.File]::ReadAllText($src, [System.Text.Encoding]::UTF8)
  $html = $html.Replace("password: '123456'", "password: '$AdminPw'")
  $html = $html.Replace("p = '123456'", "p = '$AdminPw'")
  [System.IO.File]::WriteAllText($pub, $html, (New-Object System.Text.UTF8Encoding($false)))

  # 注意：脚本顶部是 $ErrorActionPreference='Stop'。Chrome 在关闭瞬间会往 stderr 打
  # "Can't perform OS integration while the browser is shutting down." 之类的噪声，
  # PS 5.1 会把它当成终止性错误 → 整个驱动批量回归直接中断（后面驱动一个都不跑）。
  # 这里临时降级为 Continue，只依据输出文件内容判定驱动结果。
  # 另外：无头 Chrome 偶尔会"启动失败/没有任何输出"（拿到空 dump → NO-TITLE），
  #   属于环境抖动而非驱动失败 —— 这种情况自动重试 1 次，避免整批回归出现假红。
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    for ($attempt = 1; $attempt -le 2; $attempt++) {
      $tmp = Join-Path $env:TEMP ("runui" + $n + (Get-Random))
      & 'C:\Program Files\Google\Chrome\Application\chrome.exe' --headless=new --disable-gpu --no-sandbox `
          --user-data-dir=$tmp --virtual-time-budget=$Budget --dump-dom "$Base/_$n.html" 2>$null |
        Out-File -Encoding utf8 $outFile
      $probe = if (Test-Path $outFile) { Get-Content $outFile -Raw } else { '' }
      if ($probe -match '<title>') { break }
      if ($attempt -eq 1) { "  · $n 第 1 次运行无输出（无头 Chrome 抖动），自动重试…" }
    }
  } finally { $ErrorActionPreference = $prevEap }
  $raw = Get-Content $outFile -Raw
  $title = if ($raw -match '<title>([^<]*)</title>') { $Matches[1] } else { 'NO-TITLE' }
  $body = ''
  if ($raw -match '(?s)<pre id="out">(.*?)</pre>') { $body = ($Matches[1] -replace '&lt;','<' -replace '&gt;','>' -replace '&amp;','&') }
  $bad = (($body -split "`n") | Where-Object { $_ -match '✘' }) -join ' || '
  "$n => $title $bad"

  # 夹具清理：ISSUES=<id,...> / SESSIONS=<id>（支持多行/逗号分隔：驱动可能创建多场）
  if ($body -match 'ISSUES=([\d,]+)') {
    $ids = $Matches[1]
    Invoke-Sql "DELETE FROM inspection_feedbacks WHERE issue_id IN ($ids); DELETE FROM inspection_issues WHERE id IN ($ids);"
    "  · 已清理夹具问题 id=$ids"
  }
  $sessIds = @()
  foreach ($m in [regex]::Matches($body, 'SESSIONS=([\d,\s]+)')) {
    foreach ($part in ($m.Groups[1].Value -split ',')) {
      $v = $part.Trim()
      if ($v -match '^\d+$') { $sessIds += [int]$v }
    }
  }
  $sessIds = $sessIds | Sort-Object -Unique
  if ($sessIds.Count -gt 0) {
    $list = ($sessIds -join ',')
    Invoke-Sql "DELETE FROM attendance_records WHERE session_id IN ($list); DELETE FROM attendance_sessions WHERE id IN ($list); DELETE FROM operation_logs WHERE action='session_start' AND NOT EXISTS (SELECT 1 FROM attendance_sessions s WHERE s.id = (detail->>'sessionId')::int);"
    "  · 已清理场次 id=$list"
  }

  # 数据完整性看门狗（只读）：历史数据（场次/记录/计划/关联行/账号/学生）在本驱动跑完后不应减少
  #   减少 = 该驱动的"夹具清理"误删了真实数据 → 醒目告警（2026-09-29 曾发生：某驱动用
  #   `.filter(x => x.classId === created.classId)` 兜底，夹具班级创建失败时 classId 为空，
  #   结果匹配到所有"全校计划"，把关联的真实历史场次一起删了）
  $wdAfter = Get-Watchdog
  $drops = @()
  foreach ($k in @('sess', 'recs', 'plans', 'links', 'users', 'students')) {
    $b = [int]$wdBefore[$k]; $a = [int]$wdAfter[$k]
    if ($a -lt $b) { $drops += "$k $b->$a (-$($b - $a))" }
  }
  if ($drops.Count -gt 0) {
    "  ⚠⚠ 数据完整性告警：驱动 $n 之后历史数据减少 → $($drops -join '；')"
    "  ⚠⚠ 请立即核查该驱动的清理逻辑，并从 db\backup\ 备份恢复被删数据（禁止用夹具条件匹配真实数据）"
  }

  Remove-Item $outFile -Force -ErrorAction SilentlyContinue
  Remove-Item $pub -Force -ErrorAction SilentlyContinue
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
