#!/usr/bin/env bash
# Stops any running OpenFront dev server, then starts it again.
# Use after `git pull`: the game only picks up new code on a fresh start.
ps -eo pid,args | awk '$2 ~ /node$/ && $0 ~ /Server\.ts|vite/ {print $1}' | xargs -r kill
sleep 3
bash "$(dirname "$0")/start-game.sh"
