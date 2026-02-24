#!/bin/bash
# Start the tree browser server
# Uses the currently active conda/micromamba environment, or runs python3 directly
cd "$(dirname "$0")"
echo "Starting PhyloScope at http://localhost:8000"
python3 app.py
