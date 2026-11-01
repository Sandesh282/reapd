#!/usr/bin/env bash
# infra/scripts/gen-certs.sh
# Generates a wildcard mkcert certificate for *.preview.localhost.
# The certs are placed where Traefik expects them (infra/traefik/certs/).
#
# Prerequisites:
#   brew install mkcert
#   mkcert -install   (installs local CA into system trust store)
#
# Run via: npm run certs:gen

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CERT_DIR="$SCRIPT_DIR/../traefik/certs"

echo "📜 Generating wildcard TLS certificate for *.preview.localhost"
echo "   Output directory: $CERT_DIR"

mkdir -p "$CERT_DIR"

# Generate the wildcard cert.
# mkcert names the output files based on the first domain argument.
# We explicitly set -cert-file and -key-file to match Traefik's config.
mkcert \
  -cert-file "$CERT_DIR/preview.localhost.pem" \
  -key-file  "$CERT_DIR/preview.localhost-key.pem" \
  "*.preview.localhost" \
  "preview.localhost"

echo ""
echo "✅ Certificates generated:"
echo "   $CERT_DIR/preview.localhost.pem"
echo "   $CERT_DIR/preview.localhost-key.pem"
echo ""
echo "⚡ These are already trusted by Chrome/Safari via mkcert -install."
echo "   Firefox: brew install nss && mkcert -install"
echo ""
echo "▶  Start the stack now: npm run infra:up"

