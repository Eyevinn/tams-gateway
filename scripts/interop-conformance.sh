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

# The pinned schemathesis images (4.21.x, including the -trixie variants) ship
# free-threaded CPython 3.14 (Py_GIL_DISABLED=1, abiflags "t"). Hypothesis'
# shrinker crashes on the free-threaded build, so when fuzzing finds a real
# failure the run dies inside the shrinker instead of reporting it. There is no
# published schemathesis tag with a GIL-enabled interpreter, so rather than pin
# to a non-existent tag we re-enable the GIL at the interpreter level:
# PYTHON_GIL=1 is honoured by free-threaded CPython 3.13+ and forces the GIL on
# at startup. Verified 2026-06-16: `docker run -e PYTHON_GIL=1 ... python3 -c
# 'import sys; print(sys._is_gil_enabled())'` reports True (False without it).
# Ref: CPython free-threading runtime guide, PYTHON_GIL / -X gil
# (https://docs.python.org/3.14/howto/free-threading-python.html, 2026-06-16).
echo "Running Schemathesis ($IMAGE, GIL forced on) against $BASE_URL ..."
# Gate on response conformance only: do our responses match the spec's schemas,
# status codes and content types? Schemathesis' opinionated negative checks
# (auth handling, unsupported methods, strict input rejection) are robustness
# concerns, not BBC-schema conformance, so they are intentionally excluded from
# the gate. The `examples` and `fuzzing` phases generate schema-valid requests;
# the `coverage` phase (deliberate boundary/negative data) is skipped so invalid
# fuzzed data is not stored and then echoed back as a false schema violation.
CHECKS="not_a_server_error,status_code_conformance,content_type_conformance,response_schema_conformance"

exec docker run --rm --network host \
  -e PYTHON_GIL=1 \
  -v "$ROOT/spec:/spec:ro" \
  "$IMAGE" run /spec/.subset.json \
  --url "$BASE_URL" \
  --checks "$CHECKS" \
  --phases examples,fuzzing \
  --max-examples "$MAX_EXAMPLES" \
  --continue-on-failure \
  ${headers[@]+"${headers[@]}"}
