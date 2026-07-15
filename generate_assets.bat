@echo off
set "FFMPEG=C:\Users\NT01173\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-8.1.2-full_build\bin\ffmpeg.exe"
set "INPUT=E:\Naksha_Urban_project\reference_assets\original-f792719d0519f45a3a026249f6922c53.mp4"
set "OUTDIR=E:\Naksha_Urban_project\frontend\public\ai-assistant"

mkdir "%OUTDIR%"

echo Generating Mirrored Transparent WebM...
"%FFMPEG%" -y -i "%INPUT%" -vf "crop=960:960:320:120,scale=512:512,hflip,colorkey=0x010a17:0.05:0.01" -c:v libvpx-vp9 -pix_fmt yuva420p -crf 30 -b:v 1M -auto-alt-ref 0 -an "%OUTDIR%\ai-robot-loop.webm"

echo Generating Mirrored Transparent WebP...
"%FFMPEG%" -y -i "%INPUT%" -vf "crop=960:960:320:120,scale=512:512,hflip,colorkey=0x010a17:0.05:0.01" -vcodec libwebp -lossless 0 -qscale 80 -preset default -loop 0 -an -vsync 0 "%OUTDIR%\ai-robot-loop.webp"

echo Generating Mirrored Transparent Poster...
"%FFMPEG%" -y -i "%INPUT%" -vf "crop=960:960:320:120,scale=512:512,hflip,colorkey=0x010a17:0.05:0.01" -vframes 1 -c:v libwebp -quality 80 "%OUTDIR%\ai-robot-poster.webp"

echo Done!
