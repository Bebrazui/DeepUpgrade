@echo off
chcp 65001 >nul
title DeepUpgrade - Сброс настроек (Без выхода из аккаунта)

echo.
echo =================================================================
echo   DeepUpgrade Desktop: СБРОС НАСТРОЕК (СОХРАНЯЯ ВХОД В АККАУНТ)
echo =================================================================
echo.
echo Будет сброшена конфигурация терминала, разрешений и кеш страниц.
echo Авторизация, куки и сессия DeepSeek останутся сохранены!
echo.
set /p CONFIRM="Продолжить? (Y/N): "
if /i not "%CONFIRM%"=="Y" (
    echo Сброс отменён.
    pause
    exit /b 0
)

echo.
echo [1/3] Завершение активных процессов Electron...
taskkill /F /IM electron.exe >nul 2>&1

set "USER_DATA=%APPDATA%\deepupgrade-desktop"

if not exist "%USER_DATA%" (
    echo Папка данных приложения не найдена.
    pause
    exit /b 0
)

echo [2/3] Удаление конфигурации DeepUpgrade...
if exist "%USER_DATA%\deepupgrade_config.json" (
    del /F /Q "%USER_DATA%\deepupgrade_config.json" >nul 2>&1
    echo Конфигурационный файл удалён.
)

echo [3/3] Очистка временного кеша...
if exist "%USER_DATA%\Cache" rmdir /S /Q "%USER_DATA%\Cache" >nul 2>&1
if exist "%USER_DATA%\Code Cache" rmdir /S /Q "%USER_DATA%\Code Cache" >nul 2>&1
if exist "%USER_DATA%\GPUCache" rmdir /S /Q "%USER_DATA%\GPUCache" >nul 2>&1
if exist "%USER_DATA%\DawnGraphiteCache" rmdir /S /Q "%USER_DATA%\DawnGraphiteCache" >nul 2>&1
if exist "%USER_DATA%\DawnWebGPUCache" rmdir /S /Q "%USER_DATA%\DawnWebGPUCache" >nul 2>&1

echo.
echo [OK] Сброс настроек выполнен.
echo Авторизация (Network/Cookies, Local Storage, Session) сохранена!
echo При следующем запуске снова откроется окно настройки терминала.
echo.
pause
exit /b 0
