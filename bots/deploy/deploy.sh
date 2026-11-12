#!/usr/bin/env bash
# Ship the bots to the server and restart them.
#
#   bots/deploy/deploy.sh ubuntu@<host> [~/.ssh/key.pem]
#
# Assumes the host was provisioned once (see README "Hosting"): Node at
# /usr/local/bin/node, pnpm, a `fundswap` system user, the systemd template
# and logrotate config from this folder, and the secrets in place:
#   /opt/fundswap/bots/.env                                (ORACLE_SIGNER_0..2)
#   /home/fundswap/.near-credentials/testnet/{oracle,maker,keeper}.*.json
#   mainnet oracle: /opt/fundswap/bots/.env.mainnet and
#   /home/fundswap/.near-credentials/mainnet/oracle.fundswap.near.json
# Secrets are never copied by this script.
set -euo pipefail

HOST="${1:?usage: deploy.sh ubuntu@host [key.pem]}"
KEY="${2:-$HOME/.ssh/fundswap-bots.pem}"
SSH=(ssh -i "$KEY" -o BatchMode=yes -o UserKnownHostsFile="$HOME/.ssh/fundswap-bots-known_hosts")
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

cd "$ROOT"
rsync -az --delete -e "${SSH[*]}" --relative \
  --exclude node_modules --exclude logs --exclude .env --exclude .env.mainnet \
  ./package.json ./pnpm-workspace.yaml ./pnpm-lock.yaml ./bots ./intents/package.json ./client/package.json \
  "$HOST:/home/ubuntu/fundswap-release/"

"${SSH[@]}" "$HOST" 'set -e
sudo rsync -a --delete --exclude node_modules --exclude logs --exclude .env --exclude .env.mainnet /home/ubuntu/fundswap-release/ /opt/fundswap/
sudo chown -R fundswap:fundswap /opt/fundswap
cd /opt/fundswap && sudo -u fundswap -H pnpm install --frozen-lockfile --filter @fundswap/bots
sudo install -m 644 /opt/fundswap/bots/deploy/fundswap@.service /etc/systemd/system/fundswap@.service
sudo install -m 644 /opt/fundswap/bots/deploy/fundswap-mainnet@.service /etc/systemd/system/fundswap-mainnet@.service
sudo install -m 644 /opt/fundswap/bots/deploy/logrotate.conf /etc/logrotate.d/fundswap
sudo systemctl daemon-reload
sudo systemctl restart fundswap@oracle fundswap@keeper fundswap@maker
if systemctl is-enabled --quiet fundswap-mainnet@oracle 2>/dev/null; then sudo systemctl restart fundswap-mainnet@oracle; fi
systemctl is-active fundswap@oracle fundswap@keeper fundswap@maker
systemctl is-active fundswap-mainnet@oracle 2>/dev/null || true'
