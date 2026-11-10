#!/bin/bash
# Run the filter server in the foreground with Gunicorn (Ctrl-C stops it).
# Same settings as start_server.py, which the Mac app uses to start it in the background.

SERVER_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV="${VENV:-$SERVER_DIR/../.venv}"
cd "$SERVER_DIR"

# Check if server is already running on port 10000
if lsof -Pi :10000 -sTCP:LISTEN -t >/dev/null 2>&1 ; then
    echo "Server is already running on port 10000"
    exit 0
fi

# Activate virtual environment
source "$VENV/bin/activate"

exec gunicorn \
    --bind 0.0.0.0:10000 \
    --workers 1 \
    --worker-class gthread \
    --threads 8 \
    --timeout 120 \
    --pid "$SERVER_DIR/gunicorn.pid" \
    --access-logfile "$SERVER_DIR/access.log" \
    --error-logfile "$SERVER_DIR/server_error.log" \
    --log-level info \
    app:app
