<#
  server/run-tests.ps1 —— 服务端套件批量回归（带"套件间残留"自动收口）

  为什么需要它：
    1) 少数「真实数据套件」（test_absent_auto / test_absent_fix / test_ended_only /
       test_export_method / test_makeup / test_window / test_plan_* 等）会直接在真实库里
       创建场次与计划，个别失败路径会留下残留；
    2) 残留会让后续套件里"今天已发生场次 / 当前是否有进行中场次"这类断言误报
       （表现为单独跑通过、批量跑失败）；
    3) 本脚本在【每个套件运行后】把"快照之后新产生的 记录/场次/计划"清掉
       —— 只删新行，绝不触碰历史数据，使批量回归结果可复现、跑完数据库回到基线。

  用法：
    .\server\run-tests.ps1                                  # 全部 test_*.js
    .\server\run-tests.ps1 -Name test_p0_fixes.js,test_class_delete_safety.js
    .\server\run-tests.ps1 -AdminPw '#include123' -NoSweep  # 不自动收口（排查用）
#>
param(
  [string[]]$Name = @(),
  [string]$AdminPw = $env:DSH_ADMIN_PW,
  [switch]$NoSweep,
  [string]$Psql = 'D:\Program Files (x86)\PostgreSQL17\bin\psql.exe',
  [string]$Db = 'testdb',
  [string]$DbUser = 'postgres',
  [string]$DbPw = '#include123'
)

$ErrorActionPreference = 'Stop'
$serverDir = $PSScriptRoot
if (-not $AdminPw) { $AdminPw = '123456' }
$env:DSH_ADMIN_PW = $AdminPw
$env:PGPASSWORD = $DbPw

function Invoke-SqlValue([string]$sql) {
  $out = & $Psql -U $DbUser -h localhost -d $Db -t -A -c $sql 2>&1
  return ($out | Out-String).Trim()
}
function Invoke-Sql([string]$sql) {
  & $Psql -U $DbUser -h localhost -d $Db -q -c $sql 2>&1 | Out-Null
}
function Get-Marker {
  return @{
    session = [int](Invoke-SqlValue 'SELECT COALESCE(max(id),0) FROM attendance_sessions')
    plan    = [int](Invoke-SqlValue 'SELECT COALESCE(max(id),0) FROM attendance_plans')
  }
}
# 只清理"快照之后新产生"的记录/场次/计划（历史数据一行不动）
function Invoke-Sweep($marker) {
  if ($NoSweep) { return 0 }
  $s = $marker.session; $p = $marker.plan
  $n = 0
  $n += [int](Invoke-SqlValue "WITH d AS (DELETE FROM attendance_records WHERE session_id IN (SELECT id FROM attendance_sessions WHERE id > $s) RETURNING 1) SELECT count(*) FROM d")
  $n += [int](Invoke-SqlValue "WITH d AS (DELETE FROM attendance_sessions WHERE id > $s RETURNING 1) SELECT count(*) FROM d")
  $n += [int](Invoke-SqlValue "WITH d AS (DELETE FROM attendance_plans WHERE id > $p RETURNING 1) SELECT count(*) FROM d")
  return $n
}

if (-not $Name -or $Name.Count -eq 0) {
  $Name = Get-ChildItem $serverDir -Filter 'test_*.js' | ForEach-Object { $_.Name } | Sort-Object
}

$ok = 0; $skipped = 0; $failed = @()
$startMarker = Get-Marker
foreach ($f in $Name) {
  $path = Join-Path $serverDir $f
  if (-not (Test-Path $path)) { "跳过：找不到 $f"; continue }
  $marker = Get-Marker
  Push-Location $serverDir
  try {
    # 注意：脚本顶部是 $ErrorActionPreference='Stop'。node 写 stderr（例如某套件内部抛异常
    # 打印 "❌ ..."）时，PS 5.1 会把这条经 2>&1 合并进来的 stderr 当成终止性错误 →
    # 整个回归直接中断（后面的套件一个都不跑，只剩一行报错，极易误判为"全绿"）。
    # 这里临时降级为 Continue，只用 $LASTEXITCODE 判定该套件成败；stderr 仍会并入 $out 打印。
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      $out = & node $f 2>&1 | Out-String
      $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $prevEap }
  } finally { Pop-Location }
  $swept = Invoke-Sweep $marker
  $last = (($out -split "`n") | Where-Object { $_.Trim() } | Select-Object -Last 1)
  if ($last) { $last = $last.Trim() }
  if ($out -match 'SKIP 真实数据遗留套件') {
    $skipped++
    '{0,-32} SKIP' -f $f
  } elseif ($code -eq 0) {
    $ok++
    '{0,-32} PASS  {1}{2}' -f $f, $last, $(if ($swept -gt 0) { "   [已收口残留 $swept 行]" } else { '' })
  } else {
    $failed += $f
    '{0,-32} FAIL  {1}' -f $f, $last
    (($out -split "`n") | Where-Object { $_ -match '✘|✗|失败' } | Select-Object -First 5) | ForEach-Object { '        ' + $_.Trim() }
  }
}

# 收口后核对基线（场次/计划/记录）
$endSweep = Invoke-Sweep $startMarker
""
"总计：通过 $ok / 跳过 $skipped / 失败 $($failed.Count)（收口清理 $endSweep 行）"
if ($failed.Count) { "失败清单：" + ($failed -join ', ') }
"基线：sessions=$(Invoke-SqlValue 'SELECT count(*) FROM attendance_sessions') plans=$(Invoke-SqlValue 'SELECT count(*) FROM attendance_plans') records=$(Invoke-SqlValue 'SELECT count(*) FROM attendance_records')"
exit $(if ($failed.Count) { 1 } else { 0 })
