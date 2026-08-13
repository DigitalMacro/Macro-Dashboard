#!/usr/bin/env bash
# MFERM Dashboard — local development startup script
# Usage: ./start.sh

set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"

echo "=== MFERM Dashboard ==="
echo ""

# Check FRED API key
if ! grep -q "FRED_API_KEY=your_fred" "$BACKEND/.env" 2>/dev/null; then
  echo "[OK] FRED API key found"
else
  echo "[WARN] Edit $BACKEND/.env and add your FRED_API_KEY"
fi

# Start backend
echo ""
echo "[1/2] Starting FastAPI backend on http://localhost:8000 ..."
cd "$BACKEND"
source venv/bin/activate 2>/dev/null || python3 -m venv venv && source venv/bin/activate && pip install -r requirements.txt -q
export $(cat .env | xargs)
uvicorn main:app --reload --port 8000 &
BACKEND_PID=$!

# Wait for backend
sleep 3

# Start frontend
echo ""
echo "[2/2] Starting Next.js frontend on http://localhost:3000 ..."
cd "$FRONTEND"
npm run dev &
FRONTEND_PID=$!

echo ""
echo "=== Dashboard running ==="
echo "Frontend: http://localhost:3000"
echo "Backend:  http://localhost:8000"
echo "API docs: http://localhost:8000/docs"
echo ""
echo "Press Ctrl-C to stop both servers"

trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; echo 'Stopped.'" EXIT
wait
