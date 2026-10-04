@echo off
rem ============================================================
rem  ClineFreePool local server launcher (Windows)
rem
rem  Double-click this file, or run: start.bat
rem
rem  This file is intentionally ASCII-ONLY. All Chinese messages
rem  live in start.mjs, because cmd.exe mis-parses batch files
rem  containing multi-byte UTF-8 characters (it splits lines at
rem  wrong byte offsets when such a character ends a line).
rem  Chinese output from Node is fine as long as the console
rem  codepage is 65001, which is what the line below sets.
rem
rem  Keep this file UTF-8 (no BOM) with CRLF line endings.
rem  See .gitattributes for the matching rules.
rem ============================================================

chcp 65001 >nul
setlocal enableextensions
cd /d "%~dp0"
title ClineFreePool

where node >nul 2>nul
if errorlevel 1 goto :no_node

node "%~dp0start.mjs"
set "EXITCODE=%ERRORLEVEL%"

rem When launched by double-click the window closes with cmd, so any
rem error would flash by unseen. Pause only in that case; a normal
rem command-line invocation should not block the caller.
echo %cmdcmdline% | find /i "%~f0" >nul 2>nul
if not errorlevel 1 pause
endlocal
exit /b %EXITCODE%

:no_node
echo.
echo [ERROR] Node.js not found.
echo.
echo         Install Node.js first (22 LTS or newer): https://nodejs.org/
echo.
pause
endlocal
exit /b 1
