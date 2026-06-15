# Vendored BBC TAMS API specification

This directory contains a **pinned copy** of the canonical BBC TAMS
(Time-addressable Media Store) OpenAPI specification, used by the interop checks
(`pnpm run interop` and the `Interop` CI workflow) to verify that this gateway
behaves like a conformant TAMS server for the endpoints it implements.

It is a verbatim copy — do not hand-edit the files here. Local changes would
silently weaken the conformance signal.

## Pinned version

- **Source:** https://github.com/bbc/tams
- **Tag:** `8.1`
- **Commit:** `bfefbbcdfea9bcd8ee532281c60564bb57842619`
- **License:** Apache-2.0 (see headers in `TimeAddressableMediaStore.yaml`)

## Contents

- `TimeAddressableMediaStore.yaml` — the OpenAPI 3.1 document (entry point).
- `schemas/` — JSON Schemas referenced via external `$ref` from the YAML.
- `examples/` — example payloads referenced from the YAML.

`schemas/` and `examples/` are required: the YAML references them with relative
`$ref`s, so the spec does not resolve without them.

## Updating to a newer TAMS release

When BBC publishes a new tag and we want to track it:

```sh
TAG=8.2   # the new release tag
curl -sfL "https://github.com/bbc/tams/archive/refs/tags/${TAG}.tar.gz" \
  | tar xz -C /tmp
SRC="/tmp/tams-${TAG}/api"
rm -rf spec/schemas spec/examples
cp "$SRC/TimeAddressableMediaStore.yaml" spec/
cp -r "$SRC/schemas" "$SRC/examples" spec/
```

Then update the **Tag** and **Commit** above (resolve the commit with
`curl -sf https://api.github.com/repos/bbc/tams/git/refs/tags/${TAG}`), re-run
`pnpm run interop`, and review the coverage diff for newly added or changed
endpoints.
