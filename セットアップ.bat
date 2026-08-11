@echo off
rem XRoomCast セットアップウィザードの起動(Windows用)
rem ダブルクリックすると、ブラウザにウィザード画面が開きます。
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js が見つかりません。先にインストールしてください。
  echo ダウンロードページを開きます...
  start https://nodejs.org/ja/download
  echo インストール後、このファイルをもう一度ダブルクリックしてください。
  pause
  exit /b 1
)

if not exist node_modules (
  echo.
  echo 初回の準備をしています(数分かかります)...
  call npm install
  if errorlevel 1 (
    echo.
    echo 準備に失敗しました。ネットワーク接続を確認して、もう一度実行してください。
    pause
    exit /b 1
  )
)

echo.
echo セットアップウィザードを起動します。ブラウザが自動で開きます。
echo 終了するには、このウィンドウを閉じてください。
echo.
node apps\setup\server.mjs
pause
