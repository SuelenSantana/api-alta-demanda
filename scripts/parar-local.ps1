# Para o PostgreSQL portátil (a API para com Ctrl+C na janela dela).
# Uso: powershell -ExecutionPolicy Bypass -File scripts\parar-local.ps1
& "$env:LOCALAPPDATA\Programs\pgsql\bin\pg_ctl.exe" -D "$env:LOCALAPPDATA\pgdata-ingressos" -m fast stop
