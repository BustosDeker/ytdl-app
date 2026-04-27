@echo off
echo.
echo ========================================
echo   YTDL App - Setup Automatico
echo ========================================
echo.

:: Verificar Node.js
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js no esta instalado.
    echo Descargalo en: https://nodejs.org
    pause & exit /b 1
)

:: Verificar yt-dlp
yt-dlp --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] yt-dlp no encontrado en PATH.
    echo Descargando yt-dlp...
    if not exist "bin" mkdir bin
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe -o bin\yt-dlp.exe
    if %errorlevel% neq 0 (
        echo [ERROR] No se pudo descargar yt-dlp.
        echo Descargalo manualmente: https://github.com/yt-dlp/yt-dlp/releases
        echo Y coloca yt-dlp.exe en la carpeta bin\
        pause & exit /b 1
    )
    echo [OK] yt-dlp descargado en bin\yt-dlp.exe
) else (
    echo [OK] yt-dlp encontrado
)

echo.
echo Instalando dependencias npm...
call npm install
if %errorlevel% neq 0 ( echo [ERROR] npm install fallo. & pause & exit /b 1 )

echo.
echo ========================================
echo   Todo listo! Iniciando la app...
echo   Abre: http://localhost:3000
echo ========================================
echo.
call npm start
pause
