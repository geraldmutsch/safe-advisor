#!/bin/bash
set -e
cd "$(dirname "$0")"
echo "Installiere Python-Abhängigkeiten..."
pip3 install -q -r requirements.txt
echo ""
python3 server.py
