// End-to-end smoke test exercising the full TAMS write -> read path against a
// running gateway backed by a real CouchDB and S3/MinIO.
//
//   1. PUT  /flows/{id}            create a flow (and its source)
//   2. POST /flows/{id}/storage    allocate a media object + presigned PUT URL
//   3. PUT  <presigned url>        upload segment bytes to object storage
//   4. POST /flows/{id}/segments   register the segment
//   5. GET  /flows/{id}/segments   list by timerange, get a presigned GET URL
//   6. GET  <presigned url>        download and verify the bytes round-trip
//   7. DELETE /flows/{id}          start async delete (202 + Location)
//   8. poll the flow-delete-request until done, then confirm the flow is gone
//
// Env: BASE_URL (default http://localhost:8000), API_TOKEN (optional).

import { randomUUID } from 'crypto';

const BASE_URL = process.env.BASE_URL || 'http://localhost:8000';
const TOKEN = process.env.API_TOKEN;
const auth = TOKEN ? { authorization: `Bearer ${TOKEN}` } : {};

const flowId = randomUUID();
const sourceId = randomUUID();
const timerange = '[0:0_10:0)';
const payload = `tams-segment-${randomUUID()}`;

let failures = 0;
const check = (cond, message) => {
  if (cond) {
    console.log(`  ok: ${message}`);
  } else {
    console.error(`  FAIL: ${message}`);
    failures++;
  }
};

const api = async (method, path, body) => {
  // Only set a JSON content-type when there is a body; sending it on a
  // bodyless request makes Fastify reject it with 400.
  const headers = { ...auth };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  return res;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Poll a flow-delete-request until it reaches a terminal status (done/error) or
// the attempts run out. Returns the last observed status.
const pollUntilTerminal = async (requestId, attempts = 30, delayMs = 500) => {
  let status = 'unknown';
  for (let i = 0; i < attempts; i++) {
    const res = await api('GET', `/flow-delete-requests/${requestId}`);
    if (res.status === 200) {
      status = (await res.json()).status;
      if (status === 'done' || status === 'error') return status;
    }
    await sleep(delayMs);
  }
  return status;
};

const run = async () => {
  console.log(`E2E against ${BASE_URL} (flow ${flowId})`);

  // 1. Create flow
  const putRes = await api('PUT', `/flows/${flowId}`, {
    id: flowId,
    source_id: sourceId,
    format: 'urn:x-nmos:format:video',
    codec: 'video/mp2t',
    essence_parameters: { frame_width: 1920, frame_height: 1080 }
  });
  check([200, 201].includes(putRes.status), `PUT flow -> ${putRes.status}`);

  // 2. Allocate storage
  const storageRes = await api('POST', `/flows/${flowId}/storage`, {
    limit: 1
  });
  check(storageRes.status === 201, `POST storage -> ${storageRes.status}`);
  const storage = await storageRes.json();
  const object = storage.media_objects?.[0];
  check(!!object?.put_url?.url, 'storage returned a presigned PUT url');

  // 3. Upload the segment bytes to object storage
  const uploadRes = await fetch(object.put_url.url, {
    method: 'PUT',
    headers: { 'content-type': object.put_url['content-type'] },
    body: payload
  });
  check(uploadRes.ok, `upload to storage -> ${uploadRes.status}`);

  // 4. Register the segment
  const segRes = await api('POST', `/flows/${flowId}/segments`, {
    object_id: object.object_id,
    timerange
  });
  check(segRes.status === 201, `POST segment -> ${segRes.status}`);

  // 4b. Bulk-register a batch of segments in one request. This guards the
  //     existence-check in POST /flows/{id}/segments: it MUST use POST _all_docs
  //     (keys in the body). A GET _all_docs?keys= puts every id in the URL, and a
  //     real batch overflows CouchDB's URL limit -> 414 URI Too Long -> every
  //     segment fails. Unit tests mock CouchDB and cannot catch this; only a
  //     real batch against a live CouchDB does. Distinct far-away timeranges keep
  //     these out of the single-segment list check below; they are cleaned up by
  //     the DELETE at the end.
  const batch = Array.from({ length: 100 }, (_, i) => ({
    object_id: `batch-${randomUUID()}`,
    timerange: `[${1000 + i}:0_${1001 + i}:0)`
  }));
  const batchRes = await api('POST', `/flows/${flowId}/segments`, batch);
  check(
    batchRes.status === 201,
    `POST 100-segment batch -> ${batchRes.status}` +
      (batchRes.status === 200 ? ' (some failed, e.g. 414 URI too long)' : '')
  );

  // 5. List segments by timerange
  const listRes = await api(
    'GET',
    `/flows/${flowId}/segments?timerange=${encodeURIComponent(timerange)}`
  );
  check(listRes.status === 200, `GET segments -> ${listRes.status}`);
  const segments = await listRes.json();
  check(segments.length === 1, `listed ${segments.length} segment(s)`);
  const getUrl = segments[0]?.get_urls?.[0]?.url;
  check(!!getUrl, 'segment returned a presigned GET url');

  // 6. Download and verify round-trip
  const downloadRes = await fetch(getUrl);
  const downloaded = await downloadRes.text();
  check(downloaded === payload, 'downloaded bytes match uploaded bytes');

  // 7. Delete the flow. Deletion is asynchronous (TAMS spec): the request
  // returns 202 with a Location header pointing at a flow-delete-request, and
  // an in-process worker runs the per-batch delete + reclaim to completion.
  const delRes = await api('DELETE', `/flows/${flowId}`);
  check(delRes.status === 202, `DELETE flow -> ${delRes.status}`);
  const delReq = await delRes.json();
  check(
    delReq?.id && delReq.flow_id === flowId && delReq.delete_flow === true,
    'DELETE flow returned a deletion-request body'
  );
  const location = delRes.headers.get('location');
  check(
    location === `/flow-delete-requests/${delReq.id}`,
    `DELETE flow set Location -> ${location}`
  );

  // 8. Poll the flow-delete-request until the worker finishes (bounded retry),
  // then confirm the async deletion actually completed end to end: the flow is
  // gone and its media object is no longer downloadable.
  const finalStatus = await pollUntilTerminal(delReq.id);
  check(
    finalStatus === 'done',
    `delete request reached done -> ${finalStatus}`
  );

  const goneRes = await api('GET', `/flows/${flowId}`);
  check(goneRes.status === 404, `GET deleted flow -> ${goneRes.status}`);

  // The reclaimed object must no longer be downloadable from storage.
  const orphanRes = await fetch(getUrl);
  check(
    orphanRes.status === 403 || orphanRes.status === 404,
    `deleted object no longer downloadable -> ${orphanRes.status}`
  );

  if (failures > 0) {
    console.error(`\nE2E FAILED (${failures} check(s) failed)`);
    process.exit(1);
  }
  console.log('\nE2E PASSED');
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
