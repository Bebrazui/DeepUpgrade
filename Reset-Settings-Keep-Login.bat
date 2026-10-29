@echo off
title DeepUpgrade - Reset Settings (Keep Login)

echo =================================================================
echo   DeepUpgrade Desktop: RESET SETTINGS (KEEP ACCOUNT LOGIN)
echo =================================================================
echo.
echo Terminal and permission settings will be reset.
echo Your DeepSeek account session and cookies will be PRESERVED.
echo.
set /p CONFIRM="Proceed? (Y/N): "
if /i not "%CONFIRM%"=="Y" (
    echo Reset cancelled.
    pause
    exit /b 0
)

echo.
echo [1/3] Terminating Electron processes...
taskkill /F /IM electron.exe >nul 2>&1

set "USER_DATA=%APPDATA%\deepupgrade-desktop"

if not exist "%USER_DATA%" (
    echo Application data directory not found.
    pause
    exit /b 0
)

echo [2/3] Removing DeepUpgrade config...
if exist "%USER_DATA%\deepupgrade_config.json" (
    del /F /Q "%USER_DATA%\deepupgrade_config.json" >nul 2>&1
    echo Configuration file removed.
)

echo [3/3] Cleaning temporary caches...
if exist "%USER_DATA%\Cache" rmdir /S /Q "%USER_DATA%\Cache" >nul 2>&1
if exist "%USER_DATA%\Code Cache" rmdir /S /Q "%USER_DATA%\Code Cache" >nul 2>&1
if exist "%USER_DATA%\GPUCache" rmdir /S /Q "%USER_DATA%\GPUCache" >nul 2>&1
if exist "%USER_DATA%\DawnGraphiteCache" rmdir /S /Q "%USER_DATA%\DawnGraphiteCache" >nul 2>&1
if exist "%USER_DATA%\DawnWebGPUCache" rmdir /S /Q "%USER_DATA%\DawnWebGPUCache" >nul 2>&1

echo.
echo [SUCCESS] Settings reset complete.
echo Login session and cookies are safe.
echo Setup will open on the next launch.
echo.
pause
exit /b 0
