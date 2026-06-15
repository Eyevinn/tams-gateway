#!/usr/bin/env bash
#
# Response-conformance check.
#
# Runs Schemathesis (via Docker) against a *running* gateway, scoped to the
# operations the gateway implements (spec/.subset.json, produced by
# scripts/interop-coverage.ts). It generates requests from the vendored BBC TAMS
# schemas and verifies that our responses, status codes and content types
# conform to the spec — i.e. that a third-party TAMS client would interoperate
# with the endpoints we expose.
#
# Requires Docker and a reachable gateway. Environment:
#   BASE_URL            gateway base URL (default http://localhost:8000)
#   API_TOKEN           bearer token, if the gateway has auth enabled (optional)
#   MAX_EXAMPLES        generated examples per operation (default 20)
#   SCHEMATHESIS_IMAGE  override the pinned image (optional)
#
# Note: uses Docker host networking so the container can reach a gateway on
# localhost. That works on Linux/WSL and GitHub Actions; on macOS, point
# BASE_URL at http://host.docker.internal:<port> instead.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE_URL="${BASE_URL:-http://localhost:8000}"
IMAGE="${SCHEMATHESIS_IMAGE:-schemathesis/schemathesis:4.21.6}"
MAX_EXAMPLES="${MAX_EXAMPLES:-20}"
SUBSET="$ROOT/spec/.subset.json"

# Refresh the implemented-subset spec so we never test stale coverage. This also
# fails fast on a coverage regression (see scripts/interop-coverage.ts).
echo "Refreshing implemented-subset spec..."
"$ROOT/node_modules/.bin/tsx" "$ROOT/scripts/interop-coverage.ts" >/dev/null

if [ ! -f "$SUBSET" ]; then
  echo "error: $SUBSET not found (coverage step did not emit it)" >&2
  exit 1
fi

# Friendly pre-flight: make sure the gateway is actually up.
if ! curl -sf "$BASE_URL/readiness" >/dev/null 2>&1; then
  echo "error: gateway not reachable at $BASE_URL (is it running?)" >&2
  exit 1
fi

headers=()
if [ -n "${API_TOKEN:-}" ]; then
  headers=(--header "Authorization: Bearer ${API_TOKEN}")
fi

echo "Running Schemathesis ($IMAGE) against $BASE_URL ..."
exec docker run --rm --network host \
  -v "$ROOT/spec:/spec:ro" \
  "$IMAGE" run /spec/.subset.json \
  --url "$BASE_URL" \
  --checks all \
  --max-examples "$MAX_EXAMPLES" \
  --continue-on-failure \
  ${headers[@]+"${headers[@]}"}
