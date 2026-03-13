$scriptPath = Join-Path $PSScriptRoot "scripts\start-dev-windows.ps1"
& $scriptPath @args
exit $LASTEXITCODE
