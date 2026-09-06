@echo off
REM Double-click convenience wrapper for start-all.ps1.
REM Keeps the window open afterwards so the summary stays readable.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-all.ps1" %*
echo.
pause
