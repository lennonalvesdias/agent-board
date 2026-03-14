@echo off
chcp 65001 >nul
PowerShell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start.ps1"
pause
