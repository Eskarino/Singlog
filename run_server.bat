@echo off
cd /d "%~dp0"

python -m pip show flask >nul 2>&1
if errorlevel 1 (
    echo Installation de Flask...
    python -m pip install flask
)

start /min cmd /c "timeout /t 2 >nul && start http://127.0.0.1:5000"

python server.py

pause
