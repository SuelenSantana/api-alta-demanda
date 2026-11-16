# Inicia o PostgreSQL portátil (se estiver parado) e a API na porta 8080, sem Docker.
# Uso: powershell -ExecutionPolicy Bypass -File scripts\iniciar-local.ps1
$ErrorActionPreference = 'Stop'
$pgBin = "$env:LOCALAPPDATA\Programs\pgsql\bin"
$pgData = "$env:LOCALAPPDATA\pgdata-ingressos"
$env:Path = "$env:LOCALAPPDATA\Programs\nodejs;$pgBin;$env:Path"

& "$pgBin\pg_ctl.exe" -D $pgData status *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host 'Iniciando PostgreSQL...'
  & "$pgBin\pg_ctl.exe" -D $pgData -l "$pgData\servidor.log" -o "-c listen_addresses=localhost -c port=5432" -w start
}

$env:PORT = '8080'
$env:PGHOST = 'localhost'
$env:PGPORT = '5432'
$env:PGUSER = 'ingressos'
$env:PGPASSWORD = 'senha-local-apenas'
$env:PGDATABASE = 'ingressos'
$env:JWT_SECRET = 'segredo-de-demonstracao-mude-em-producao-2026'

Set-Location (Split-Path $PSScriptRoot -Parent)
Write-Host 'API em http://localhost:8080 (Ctrl+C para parar a API)'
node src/app.js
