#!/bin/bash
# Start Python FastAPI backend (simple health-check server)
echo "Starting SMSTracker FastAPI backend..."

PYTHON_CMD="python"
if [ -d "./venv" ]; then
    PYTHON_CMD="./venv/bin/python"
fi

$PYTHON_CMD -m uvicorn main:app --host 0.0.0.0 --port 8000
