#!/bin/bash
set -e

VPS_HOST="${VPS_HOST:-user@your-vps}"
VPS_DIR="/opt/music-api"
SERVICE_NAME="music-api"

echo "Installing production dependencies..."
npm ci --only=production

echo "Uploading to VPS..."
rsync -avz --progress \
  --exclude node_modules \
  --exclude .git \
  . "$VPS_HOST:$VPS_DIR/"

echo "Installing dependencies on VPS..."
ssh "$VPS_HOST" "cd $VPS_DIR && npm ci --only=production"

echo "Restarting service..."
ssh "$VPS_HOST" "sudo systemctl restart $SERVICE_NAME && sudo systemctl status $SERVICE_NAME --no-pager"

echo "Done!"
