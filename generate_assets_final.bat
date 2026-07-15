@echo off
set "FFMPEG=C:\Users\NT01173\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-8.1.2-full_build\bin\ffmpeg.exe"
set "OUTDIR=E:\Naksha_Urban_project\frontend\public\ai-assistant"
set "FRAMES=E:\Naksha_Urban_project\processed_frames"

mkdir "%OUTDIR%" 2>nul

echo Re-assembling WebM...
"%FFMPEG%" -y -framerate 30 -i "%FRAMES%\frame_%%03d.png" -c:v libvpx-vp9 -pix_fmt yuva420p -crf 30 -b:v 1M -auto-alt-ref 0 -an "%OUTDIR%\ai-robot-loop.webm"

echo Re-assembling WebP...
"%FFMPEG%" -y -framerate 30 -i "%FRAMES%\frame_%%03d.png" -vcodec libwebp -lossless 0 -qscale 80 -preset default -loop 0 -an -vsync 0 "%OUTDIR%\ai-robot-loop.webp"

echo Re-assembling Poster...
"%FFMPEG%" -y -i "%FRAMES%\frame_000.png" -c:v libwebp -quality 80 "%OUTDIR%\ai-robot-poster.webp"

echo Copying to bot_animation/public/ai-assistant...
mkdir "E:\Naksha_Urban_project\bot_animation\public\ai-assistant" 2>nul
copy /y "%OUTDIR%\*" "E:\Naksha_Urban_project\bot_animation\public\ai-assistant\"

echo Done!
