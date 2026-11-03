@echo off
rem Mo Writer - background supervisor
rem Keeps the web service alive with no window, so the phone and the browser
rem keep working after the desktop window is closed.
rem Keep this file ASCII-only: cmd.exe reads .bat in the system ANSI codepage,
rem and non-ASCII comments corrupt command parsing.

setlocal
cd /d "%~dp0"

rem Prefer the bundled runtime, so this also works on a machine without Node.js.
set "NODEEXE=%~dp0node\node.exe"
if not exist "%NODEEXE%" set "NODEEXE=C:\Program Files\nodejs\node.exe"
if not exist "%NODEEXE%" set "NODEEXE=node"

if not exist "data" mkdir "data"

:loop
rem Graceful stop: the desktop app creates this file before killing node, so
rem the supervisor knows the downtime was wanted and stays down instead of
rem fighting back with a restart.
if exist "%~dp0data\stop.request" goto :stopped

"%NODEEXE%" "%~dp0server.js" >> "%~dp0data\server.log" 2>&1
set "CODE=%ERRORLEVEL%"

rem exit code 0 means "port already in use" -> another instance is serving, stop.
if "%CODE%"=="0" goto :end

rem Crashed. Give it a moment, then bring it back.
timeout /t 5 /nobreak >nul
goto :loop

:stopped
del "%~dp0data\stop.request" >nul 2>&1
echo [supervisor] stopped on request %DATE% %TIME%>> "%~dp0data\server.log"

:end
endlocal
