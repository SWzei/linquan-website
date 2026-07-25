#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Please run as root."
  exit 1
fi

DOMAIN="${DOMAIN:-}"
EMAIL="${EMAIL:-}"

if [[ -z "${DOMAIN}" || -z "${EMAIL}" ]]; then
  echo "Usage:"
  echo "DOMAIN=linquanpiano.cn EMAIL=admin@linquanpiano.cn bash deploy/aliyun/05_enable_https.sh"
  exit 1
fi

apt update
apt install -y certbot python3-certbot-nginx

certbot --nginx \
  -d "${DOMAIN}" \
  -d "www.${DOMAIN}" \
  --agree-tos \
  --redirect \
  --non-interactive \
  --email "${EMAIL}"

systemctl reload nginx
echo "HTTPS is enabled for ${DOMAIN}."
