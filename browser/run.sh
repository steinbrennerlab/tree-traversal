#!/bin/bash
# Start the tree browser server
# Uses the currently active conda/micromamba environment
cd "$(dirname "$0")"
echo "Starting PhyloScope at http://localhost:8000"
python app.py
