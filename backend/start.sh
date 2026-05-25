#!/bin/bash

# Start Node.js WhatsApp bridge on port 3000
echo "Starting Node.js WhatsApp Web Bridge..."
node whatsapp-bridge.js &
NODE_PID=$!

# Let the bridge initialize and start loading
sleep 3

# Start Python FastAPI backend on port 8000
echo "Starting Python FastAPI Backend..."
PYTHON_CMD="python"
if [ -d "./venv" ]; then
    PYTHON_CMD="./venv/bin/python"
fi
$PYTHON_CMD -m uvicorn main:app --host 0.0.0.0 --port 8000 &
PYTHON_PID=$!

# Graceful shutdown handler
cleanup() {
    echo "Stopping background processes (Node: $NODE_PID, Python: $PYTHON_PID)..."
    kill -TERM "$NODE_PID" "$PYTHON_PID" 2>/dev/null
    exit 0
}

trap cleanup SIGINT SIGTERM

# Wait for both processes
wait "$NODE_PID" "$PYTHON_PID"
