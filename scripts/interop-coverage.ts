// Interop coverage diff.
//
// Compares the gateway's generated OpenAPI surface against the vendored BBC TAMS
// specification under spec/, and reports which spec operations the gateway
// implements, which are gateway-only extensions, and which are missing.
//
// Side effects:
//   - Emits spec/.subset.json: the vendored spec trimmed to only the operations
//     the gateway implements. The Schemathesis conformance step runs against
//     this subset so it validates our responses against the real BBC schemas
//     without flagging the (intentionally) unimplemented endpoints.
//   - On first run, writes spec/interop-baseline.json (the set of implemented
//     operations). On later runs, fails if any baselined operation has
//     disappeared — a coverage regression — while reporting newly added ones.
//
// This check needs no running server or backing services: it builds the Fastify
// app in-process and reads its generated schema. Run with: pnpm run interop.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parse } from 'yaml';
import api from '../src/api/api';

const HTTP_METHODS = [
  'get',
  'put',
  'post',
  'delete',
  'head',
  'patch',
  'options'
];

interface OpenApiDoc {
  paths?: Record<string, Record<string, unknown>>;
}

const ROOT = process.cwd();
const SPEC_DIR = join(ROOT, 'spec');
const SPEC_FILE = join(SPEC_DIR, 'TimeAddressableMediaStore.yaml');
const SUBSET_FILE = join(SPEC_DIR, '.subset.json');
const BASELINE_FILE = join(SPEC_DIR, 'interop-baseline.json');

// Collapse path-parameter names so the gateway's `{id}` lines up with the
// spec's `{flowId}`: /flows/{id}/segments and /flows/{flowId}/segments both
// normalise to /flows/{}/segments.
const normPath = (p: string): string => {
  const stripped = p.replace(/\{[^}]+\}/g, '{}').replace(/\/+$/, '');
  return stripped === '' ? '/' : stripped;
};

const opKey = (method: string, path: string): string =>
  `${method.toUpperCase()} ${normPath(path)}`;

interface Operation {
  method: string;
  path: string;
  key: string;
}

const collectOps = (doc: OpenApiDoc): Operation[] => {
  const ops: Operation[] = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const method of Object.keys(item)) {
      if (HTTP_METHODS.includes(method.toLowerCase())) {
        ops.push({
          method: method.toLowerCase(),
          path,
          key: opKey(method, path)
        });
      }
    }
  }
  return ops;
};

const main = async (): Promise<number> => {
  // 1. Vendored BBC spec inventory.
  const specDoc = parse(readFileSync(SPEC_FILE, 'utf8')) as OpenApiDoc;
  const specOps = collectOps(specDoc);
  const specByKey = new Map(specOps.map((op) => [op.key, op]));

  // 2. Gateway's generated surface (built in-process, no backing services).
  const app = api({ title: 'TAMS-Gateway' });
  await app.ready();
  const gatewayDoc = app.swagger() as unknown as OpenApiDoc;
  await app.close();
  const gatewayOps = collectOps(gatewayDoc);
  const gatewayKeys = new Set(gatewayOps.map((op) => op.key));

  // 3. Categorise.
  const implemented = gatewayOps.filter((op) => specByKey.has(op.key));
  const extra = gatewayOps.filter((op) => !specByKey.has(op.key));
  const missing = specOps.filter((op) => !gatewayKeys.has(op.key));
  const implementedKeys = [...new Set(implemented.map((op) => op.key))].sort();

  // 4. Emit the implemented-subset spec for the conformance step. Start from a
  //    deep clone of the vendored spec (so external $refs stay relative to
  //    spec/) and prune to only the implemented operations.
  const subset = JSON.parse(JSON.stringify(specDoc)) as OpenApiDoc;
  const implementedKeySet = new Set(implementedKeys);
  for (const [path, item] of Object.entries(subset.paths ?? {})) {
    for (const method of Object.keys(item)) {
      if (
        HTTP_METHODS.includes(method.toLowerCase()) &&
        !implementedKeySet.has(opKey(method, path))
      ) {
        delete item[method];
      }
    }
    const hasMethod = Object.keys(item).some((m) =>
      HTTP_METHODS.includes(m.toLowerCase())
    );
    if (!hasMethod && subset.paths) {
      delete subset.paths[path];
    }
  }
  writeFileSync(SUBSET_FILE, JSON.stringify(subset, null, 2) + '\n');

  // 5. Report.
  const pct = ((implementedKeys.length / specOps.length) * 100).toFixed(1);
  console.log('TAMS interop coverage (gateway vs vendored BBC spec 8.1)\n');
  console.log(`  spec operations:        ${specOps.length}`);
  console.log(`  implemented by gateway: ${implementedKeys.length} (${pct}%)`);
  console.log(`  gateway-only (extra):   ${extra.length}`);
  console.log(`  missing from gateway:   ${missing.length}\n`);

  console.log('Implemented (validated by the conformance step):');
  for (const op of implemented.sort((a, b) => a.key.localeCompare(b.key))) {
    console.log(`  + ${op.method.toUpperCase().padEnd(6)} ${op.path}`);
  }
  if (extra.length) {
    console.log('\nGateway-only (not in spec):');
    for (const op of extra.sort((a, b) => a.key.localeCompare(b.key))) {
      console.log(`  ~ ${op.method.toUpperCase().padEnd(6)} ${op.path}`);
    }
  }
  console.log(
    `\n${missing.length} spec operation(s) not implemented (expected for a subset).`
  );

  // 6. Baseline regression guard.
  if (existsSync(BASELINE_FILE)) {
    const baseline = JSON.parse(
      readFileSync(BASELINE_FILE, 'utf8')
    ) as string[];
    const regressed = baseline.filter((k) => !implementedKeySet.has(k));
    const added = implementedKeys.filter((k) => !baseline.includes(k));
    if (added.length) {
      console.log('\nNewly implemented since baseline:');
      added.forEach((k) => console.log(`  + ${k}`));
      console.log('  (run with UPDATE_BASELINE=1 to record these)');
    }
    if (regressed.length) {
      console.error(
        '\nCOVERAGE REGRESSION — these operations are no longer implemented:'
      );
      regressed.forEach((k) => console.error(`  - ${k}`));
      return 1;
    }
    if (process.env.UPDATE_BASELINE) {
      writeFileSync(
        BASELINE_FILE,
        JSON.stringify(implementedKeys, null, 2) + '\n'
      );
      console.log('\nBaseline updated.');
    }
  } else {
    writeFileSync(
      BASELINE_FILE,
      JSON.stringify(implementedKeys, null, 2) + '\n'
    );
    console.log('\nWrote initial baseline to spec/interop-baseline.json');
  }

  return 0;
};

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
