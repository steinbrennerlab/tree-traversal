#!/bin/bash
# Start the tree browser server
cd "$(dirname "$0")"
echo "Starting Tree Browser at http://localhost:8000"
micromamba run -n base python3 app.py
