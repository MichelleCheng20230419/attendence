# 一键存档：代码(git) + 数据库(PostgreSQL)
# 由 backup.bat 调用（双击即可）
$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot

Write-Host "============================================"
Write-Host "  一键存档：代码(git) + 数据库(PostgreSQL)"
Write-Host "============================================"

Write-Host "[1/3] 暂存所有修改..."
git add -A

Write-Host "[2/3] 提交到 git（自动存档）..."
git commit -m "auto backup $(Get-Date -Format 'yyyy-MM-dd HH:mm')"

Write-Host "[3/3] 备份数据库..."
$env:PGPASSWORD = '#include123'
$ts = Get-Date -Format 'yyyyMMdd'
& "D:\Program Files (x86)\PostgreSQL17\bin\pg_dump.exe" -U postgres -d testdb -h 127.0.0.1 -f "db\backup\testdb_$ts.sql"
Copy-Item "server\.env" "db\backup\env_$ts.env" -Force

Write-Host "============================================"
Write-Host "  存档完成！"
Write-Host "  代码存档  ：git 最近一次提交（可随时回滚）"
Write-Host "  数据库备份：db\backup\testdb_$ts.sql"
Write-Host "  配置备份  ：db\backup\env_$ts.env"
Write-Host "============================================"
