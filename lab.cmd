@echo off
rem Car lab: the ?tune=1 page with the Build tools, on this PC's Wi-Fi address,
rem port 8001 -- next to the plain site on port 8000. Double-click to start,
rem close the window (or Ctrl+C) to stop. See tools/lab-server.mjs for details.
cd /d "%~dp0"
node tools/lab-server.mjs --host auto --port 8001 --open
pause
