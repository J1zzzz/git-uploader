@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title GitHub Upload Panel

echo ==================================================
echo    GitHub Upload Panel
echo ==================================================
echo.

rem ==================== 1. Node.js ====================
set "NODE_EXE="
where node >nul 2>nul
if not errorlevel 1 set "NODE_EXE=node"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

if not defined NODE_EXE (
  echo [!] Node.js not found. Installing Node.js LTS via winget...
  call :winget_install OpenJS.NodeJS.LTS
  where node >nul 2>nul
  if not errorlevel 1 set "NODE_EXE=node"
  if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
)

if not defined NODE_EXE (
  echo.
  echo [X] Node.js is required but was not found.
  echo     Install it manually: https://nodejs.org/en/download
  echo     Then run start.bat again.
  echo.
  pause
  exit /b 1
)

for /f "delims=v." %%a in ('"%NODE_EXE%" -v') do set "NODE_MAJOR=%%a"
echo [OK] Node.js %NODE_MAJOR%

rem ==================== 2. Git ====================
set "GIT_EXE="
where git >nul 2>nul
if not errorlevel 1 set "GIT_EXE=git"
if not defined GIT_EXE if exist "%ProgramFiles%\Git\cmd\git.exe" set "GIT_EXE=%ProgramFiles%\Git\cmd\git.exe"
if not defined GIT_EXE if exist "%LOCALAPPDATA%\Programs\Git\cmd\git.exe" set "GIT_EXE=%LOCALAPPDATA%\Programs\Git\cmd\git.exe"

if not defined GIT_EXE (
  echo [!] Git not found. Installing Git via winget...
  call :winget_install Git.Git
  where git >nul 2>nul
  if not errorlevel 1 set "GIT_EXE=git"
  if not defined GIT_EXE if exist "%ProgramFiles%\Git\cmd\git.exe" set "GIT_EXE=%ProgramFiles%\Git\cmd\git.exe"
)

if not defined GIT_EXE (
  echo.
  echo [X] Git is required but was not found.
  echo     Install it manually: https://git-scm.com/download/win
  echo     Then run start.bat again.
  echo.
  pause
  exit /b 1
)
for /f "tokens=*" %%v in ('"%GIT_EXE%" --version') do echo [OK] %%v

rem ==================== 3. GitHub CLI ====================
set "GH_EXE="
where gh >nul 2>nul
if not errorlevel 1 set "GH_EXE=gh"
if not defined GH_EXE if exist "%ProgramFiles%\GitHub CLI\gh.exe" set "GH_EXE=%ProgramFiles%\GitHub CLI\gh.exe"
if not defined GH_EXE if exist "%ProgramFiles(x86)%\GitHub CLI\gh.exe" set "GH_EXE=%ProgramFiles(x86)%\GitHub CLI\gh.exe"
if not defined GH_EXE if exist "%LOCALAPPDATA%\GitHubCLI\gh.exe" set "GH_EXE=%LOCALAPPDATA%\GitHubCLI\gh.exe"
if not defined GH_EXE if exist "%LOCALAPPDATA%\Microsoft\WinGet\Links\gh.exe" set "GH_EXE=%LOCALAPPDATA%\Microsoft\WinGet\Links\gh.exe"

if not defined GH_EXE (
  echo [!] GitHub CLI not found. Installing GitHub CLI via winget...
  call :winget_install GitHub.cli
  where gh >nul 2>nul
  if not errorlevel 1 set "GH_EXE=gh"
  if not defined GH_EXE if exist "%ProgramFiles%\GitHub CLI\gh.exe" set "GH_EXE=%ProgramFiles%\GitHub CLI\gh.exe"
)

if not defined GH_EXE (
  echo.
  echo [X] GitHub CLI is required but was not found.
  echo     Install it manually: https://cli.github.com/  or  winget install GitHub.cli
  echo     Then run start.bat again.
  echo.
  pause
  exit /b 1
)
for /f "tokens=*" %%v in ('"%GH_EXE%" --version') do echo [OK] %%v

echo.
echo --------------------------------------------------
echo   Starting local server... keep this window open.
echo   Press Ctrl+C or close this window to stop.
echo --------------------------------------------------
echo.

"%NODE_EXE%" server.js --open
echo.
echo Server stopped.
pause
exit /b 0

rem ==================== helpers ====================
:winget_install
where winget >nul 2>nul
if errorlevel 1 (
  echo     winget is not available on this system - manual install needed.
  exit /b 1
)
winget install --id %~1 -e --silent --accept-package-agreements --accept-source-agreements
exit /b 0
