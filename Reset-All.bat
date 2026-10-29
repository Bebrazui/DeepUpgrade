@echo off
chcp 65001 >nul
title DeepUpgrade - Полный сброс

echo.
echo ========================================================
echo       DeepUpgrade Desktop: ПОЛНЫЙ СБРОС (WIPE ALL)
echo ========================================================
echo.
echo ВНИМАНИЕ: Будут удалены все настройки, конфиги, кеш
echo и данные авторизации (сессия аккаунта DeepSeek).
echo.
set /p CONFIRM="Вы уверены, что хотите выполнить полный сброс? (Y/N): "
if /i not "%CONFIRM%"=="Y" (
    echo Сброс отменён.
    pause
    exit /b 0
)

echo.
echo [1/2] Завершение активных процессов Electron...
taskkill /F /IM electron.exe >nul 2>&1

echo [2/2] Удаление директории профиля пользователя...
set "TARGET_DIR=%APPDATA%\deepupgrade-desktop"
if exist "%TARGET_DIR%" (
    rmdir /S /Q "%TARGET_DIR%" >nul 2>&1
    echo Данные успешно удалены: %TARGET_DIR%
) else (
    echo Папка профиля уже пуста.
)

echo.
echo [OK] Полный сброс успешно завершён.
echo При следующем запуске откроется первичная настройка.
echo.
pause
exit /b 0
