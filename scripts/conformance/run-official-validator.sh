#!/usr/bin/env bash
# Runs the official Personal Agent Protocol Company validator against Haat over real HTTPS.
# Needs: root (port 443 and /etc/hosts), git, openssl, Node 22.18+.
# Usage: sudo scripts/conformance/run-official-validator.sh [milestone]   (default: all)
set -euo pipefail
MILESTONE="${1:-all}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="${WORK:-/tmp/haat-conformance}"
SPEC_COMMIT="${SPEC_COMMIT:-1de1990}"   # spec repo commit this was last run against
mkdir -p "$WORK"

# 1. The validator, from the spec repository, pinned.
if [ ! -d "$WORK/pap" ]; then
  git clone -q https://github.com/personal-agent-protocol/personal-agent-protocol.git "$WORK/pap"
fi
git -C "$WORK/pap" fetch -q --depth 50 origin main || true
git -C "$WORK/pap" checkout -q "$SPEC_COMMIT" 2>/dev/null || echo "note: using $(git -C "$WORK/pap" rev-parse --short HEAD)"
VALIDATOR="$WORK/pap/kit/company"

# 2. Local CA and a certificate for haat.localhost and agent.localhost.
if [ ! -f "$WORK/ca.crt" ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 7 -subj "/CN=Haat local CA" -keyout "$WORK/ca.key" -out "$WORK/ca.crt" 2>/dev/null
  openssl req -newkey rsa:2048 -nodes -subj "/CN=haat.localhost" -keyout "$WORK/server.key" -out "$WORK/server.csr" 2>/dev/null
  printf "subjectAltName=DNS:haat.localhost,DNS:agent.localhost\nbasicConstraints=CA:FALSE\n" > "$WORK/ext.cnf"
  openssl x509 -req -in "$WORK/server.csr" -CA "$WORK/ca.crt" -CAkey "$WORK/ca.key" -CAcreateserial -days 7 -extfile "$WORK/ext.cnf" -out "$WORK/server.crt" 2>/dev/null
fi
grep -q "haat.localhost" /etc/hosts || echo "127.0.0.1 haat.localhost agent.localhost" >> /etc/hosts
export NODE_EXTRA_CA_CERTS="$WORK/ca.crt"

# 3. The validator's test Personal Agent.
( cd "$VALIDATOR" && [ -f .poppy/agent.json ] || node validate/index.ts keygen --base-url https://agent.localhost:8443 >/dev/null )

# 4. Start Haat over HTTPS and serve the test agent's files.
CONF_DIR="$WORK" VALIDATOR_DIR="$VALIDATOR" node "$ROOT/scripts/conformance/serve.ts" > "$WORK/serve.log" 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do grep -q ready "$WORK/serve.log" 2>/dev/null && break; sleep 0.2; done

# 5. Run it.
cd "$VALIDATOR"
node validate/index.ts check https://haat.localhost --milestone "$MILESTONE" --allow-private-addresses --json > "$WORK/results.json" || true
node validate/index.ts check https://haat.localhost --milestone "$MILESTONE" --allow-private-addresses | tee "$WORK/results.txt" | tail -40
