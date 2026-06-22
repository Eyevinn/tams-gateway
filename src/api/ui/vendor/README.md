# Vendored third-party assets

## hls.min.js

- Library: hls.js
- Version: 1.6.16
- License: Apache-2.0 (Copyright (c) 2017 Dailymotion)
- Source: `node_modules/hls.js/dist/hls.min.js` from `pnpm add hls.js@1.6.16`

Vendored as a static asset (ADR-007 constraint C1: no SPA / no bundler, and the
asset is served from this origin, never a CDN). The npm package is intentionally
NOT a dependency in `package.json`: the file is committed here so the inspector
UI ships with the gateway image without adding hls.js to the production install.

To upgrade: `pnpm add hls.js@<version>`, copy `node_modules/hls.js/dist/hls.min.js`
over this file, `pnpm remove hls.js`, and bump the version above.
