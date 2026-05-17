#!/bin/bash
set -e
cd "$(dirname "$0")"

echo "Installiere/aktualisiere Python-Abhängigkeiten..."
pip3 install -q --upgrade bimmer-connected flask

echo ""
INSTALLED=$(pip3 show bimmer-connected 2>/dev/null | grep Version | awk '{print $2}')
echo "bimmer-connected $INSTALLED bereit."
echo ""

python3 server.py
