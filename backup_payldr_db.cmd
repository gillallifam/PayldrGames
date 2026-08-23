@echo off
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0backup_payldr_db.ps1"
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Ocorreu um erro no backup.
    pause
)
