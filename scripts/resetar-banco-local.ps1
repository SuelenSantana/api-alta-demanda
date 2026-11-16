# Apaga e recria o banco "ingressos" (equivalente a docker compose down -v).
# ATENÇÃO: apaga todos os usuários e pedidos. Pare a API antes de rodar.
# Uso: powershell -ExecutionPolicy Bypass -File scripts\resetar-banco-local.ps1
$ErrorActionPreference = 'Stop'
$pgBin = "$env:LOCALAPPDATA\Programs\pgsql\bin"
$pgData = "$env:LOCALAPPDATA\pgdata-ingressos"

& "$pgBin\pg_ctl.exe" -D $pgData status *> $null
if ($LASTEXITCODE -ne 0) {
  & "$pgBin\pg_ctl.exe" -D $pgData -l "$pgData\servidor.log" -o "-c listen_addresses=localhost -c port=5432" -w start
}

$env:PGPASSWORD = 'admin-local'
& "$pgBin\psql.exe" -h localhost -U postgres -v ON_ERROR_STOP=1 -q `
  -c 'DROP DATABASE IF EXISTS ingressos WITH (FORCE);' `
  -c 'CREATE DATABASE ingressos OWNER ingressos;'

$env:PGPASSWORD = 'senha-local-apenas'
& "$pgBin\psql.exe" -h localhost -U ingressos -d ingressos -v ON_ERROR_STOP=1 -q `
  -f (Join-Path (Split-Path $PSScriptRoot -Parent) 'database\init.sql')
Write-Host 'Banco recriado: show 7 com 100 vagas livres.'
