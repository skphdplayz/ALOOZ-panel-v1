#!/usr/bin/env bash
set -euo pipefail

# Usage:
# curl -fsSL https://raw.githubusercontent.com/USERNAME/REPO/main/install.sh | bash -s -- USERNAME/REPO
REPO_SLUG="${1:-}"
if [[ ! "$REPO_SLUG" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
  echo "Usage: bash install.sh USERNAME/REPOSITORY"
  echo "When using curl: curl -fsSL https://raw.githubusercontent.com/USERNAME/REPO/main/install.sh | bash -s -- USERNAME/REPO"
  exit 1
fi

APP_DIR="${APP_DIR:-$HOME/alooz-vps-deploy}"
RAW_BASE="https://raw.githubusercontent.com/${REPO_SLUG}/main"

if [[ $EUID -eq 0 ]]; then
  echo "Please run as a normal sudo-capable user, not root."
  exit 1
fi

echo "== ALOOZ VPS Deploy Bot: two-file installer =="

if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(Number(process.versions.node.split(".")[0] < 20))'; then
  echo "Installing Node.js 20..."
  sudo apt-get update
  sudo apt-get install -y ca-certificates curl
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

sudo apt-get update
sudo apt-get install -y curl

mkdir -p "$APP_DIR"
chmod 700 "$APP_DIR"

echo "Downloading bot.js from ${REPO_SLUG}..."
curl -fL "$RAW_BASE/bot.js" -o "$APP_DIR/bot.js"
chmod 600 "$APP_DIR/bot.js"

cd "$APP_DIR"
npm install --no-save discord.js@14 ssh2 dotenv

if [[ ! -f .env ]]; then
  echo
  echo "Discord bot configuration"
  read -r -p "Discord Bot Token: " DISCORD_TOKEN
  read -r -p "Discord Application / Client ID: " CLIENT_ID
  read -r -p "Discord Server / Guild ID: " GUILD_ID
  read -r -p "Your Discord User ID (admin): " ADMIN_IDS

  umask 077
  cat > .env <<EOF
DISCORD_TOKEN=${DISCORD_TOKEN}
CLIENT_ID=${CLIENT_ID}
GUILD_ID=${GUILD_ID}
ADMIN_IDS=${ADMIN_IDS}
DATA_DIR=./data
EOF
  chmod 600 .env
else
  echo ".env already exists; keeping current configuration."
fi

echo
echo "Installation finished."
echo "Start the bot with:"
echo "  cd \"$APP_DIR\" && node bot.js"
echo
echo "Keep this terminal/session open for the bot to stay online."
echo "For 24/7 operation, configure a systemd service after confirming the bot works."
