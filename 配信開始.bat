@echo off
rem XRoomCast 配信の中継(ブリッジ)を起動する(Windows用)
rem VSeeFace等のVMC送信を受け取り、Cloudflareへ配信します。
rem 使い方は docs/配信者ガイド.md を参照。
chcp 65001 >nul
cd /d "%~dp0"

if not exist .env (
  echo.
  echo 設定ファイル(.env)が見つかりません。
  echo 先に「セットアップ.bat」を実行して、セットアップを完了してください。
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js が見つかりません。「セットアップ.bat」を先に実行してください。
  pause
  exit /b 1
)

echo.
echo 配信の中継を開始します。この窓は開いたままにしてください。
echo (VSeeFace側で OSC/VMC送信を有効にすると、アバターが動き出します)
echo 配信をやめるときは、この窓を閉じてください。
echo.
call npm run bridge
pause
