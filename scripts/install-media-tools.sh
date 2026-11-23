#!/usr/bin/env bash
# Installs ffmpeg (+ python3-pil) and yt-dlp on a GitHub runner, retrying when an Ubuntu mirror hangs
# (the daily run lost 2026-11-10 and 2026-11-20 to a single hung apt-get).
set -u
pkgs="ffmpeg python3-pil"
for i in 1 2 3; do
  if timeout 120 sudo apt-get update -qq && timeout 240 sudo apt-get install -y -qq $pkgs; then break; fi
  echo "apt attempt $i failed or hung; retrying in 15 s"
  sleep 15
done
command -v ffmpeg >/dev/null || { echo "ffmpeg could not be installed"; exit 1; }
pip install -q "yt-dlp[default]"
