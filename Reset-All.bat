@echo off
title DeepUpgrade - Full Reset

echo ========================================================
echo       DeepUpgrade Desktop: FULL WIPE (RESET ALL)
echo ========================================================
echo.
echo WARNING: This will remove all settings, caches,
echo and account login session data.
echo.
set /p CONFIRM="Are you sure you want to completely reset? (Y/N): "
if /i not "%CONFIRM%"=="Y" (
    echo Reset cancelled.
    pause
    exit /b 0
)

echo.
echo [1/2] Terminating Electron processes...
taskkill /F /IM electron.exe >nul 2>&1

echo [2/2] Removing user profile directory...
set "TARGET_DIR=%APPDATA%\deepupgrade-desktop"
if exist "%TARGET_DIR%" (
    rmdir /S /Q "%TARGET_DIR%" >nul 2>&1
    echo User profile directory removed successfully.
) else (
    echo Profile directory is already clean.
)

echo.
echo [SUCCESS] Full wipe complete.
echo Setup will appear on the next launch.
echo.
pause
exit /b 0
