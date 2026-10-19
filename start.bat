@echo off
title Ant Arcade - local preview
cd /d "%~dp0"

where py >nul 2>nul
if %errorlevel%==0 (
  py tools\dev_server.py %*
) else (
  python tools\dev_server.py %*
)

if errorlevel 1 pause
