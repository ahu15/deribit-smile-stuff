@echo off
cd /d "%~dp0"
start "deribit backend"  cmd /k python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
start "deribit frontend" cmd /k npm run dev --prefix frontend
timeout /t 4 >nul
start "" http://localhost:5173
