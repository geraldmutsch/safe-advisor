#!/bin/bash
set -e
cd "$(dirname "$0")"

echo "Installiere/aktualisiere Python-Abhängigkeiten..."
pip3 install -q --upgrade flask httpx

echo ""
echo "Flask und httpx bereit."
echo ""

python3 server.py
