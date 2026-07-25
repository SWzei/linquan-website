#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Please run as root."
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

echo "[1/6] System update..."
apt update
apt upgrade -y

echo "[2/6] Installing base packages..."
apt install -y curl git unzip build-essential ufw ca-certificates gnupg lsb-release

echo "[3/6] Installing Node.js 20 LTS..."
if ! command -v node >/dev/null 2>&1 || ! node -v | grep -q '^v20\.'; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt install -y nodejs
fi

echo "[4/6] Installing PM2..."
npm install -g pm2

echo "[5/6] Installing and enabling Nginx..."
apt install -y nginx
systemctl enable nginx
systemctl start nginx

echo "[6/6] Configuring firewall..."
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

if ! swapon --show | grep -q '/swapfile'; then
  echo "Configuring 2G swapfile for small-memory instance..."
  if ! fallocate -l 2G /swapfile; then
    dd if=/dev/zero of=/swapfile bs=1M count=2048 status=progress
  fi
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  if ! grep -q '/swapfile' /etc/fstab; then
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
  fi
fi

echo "Done."
echo "node: $(node -v)"
echo "npm:  $(npm -v)"
echo "pm2:  $(pm2 -v)"
echo "nginx: $(nginx -v 2>&1)"
