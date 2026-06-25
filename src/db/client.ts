import nano, { DocumentScope } from 'nano';
import { DBFlow } from './schemas/flows/Flow';
import Logger from '../utils/Logger';
import { Static } from '@sinclair/typebox';
import { DBSource } from './schemas/sources/Source';
import { DBSegment } from './schemas/segments/Segments';
import { DBWebhook } from './schemas/webhooks/Webhook';
import { DBDeletionRequest } from './schemas/deletion-requests/DeletionRequest';

const url = new URL(process.env.DB_URL || 'http://localhost:8000');
url.username = process.env.DB_USERNAME || '';
url.password = process.env.DB_PASSWORD || '';
const client = nano(url.toString());
const flowsClient: DocumentScope<Static<typeof DBFlow>> = client.use('flows');
const sourcesClient: DocumentScope<Static<typeof DBSource>> =
  client.use('sources');
const segmentsClient: DocumentScope<Static<typeof DBSegment>> =
  client.use('segments');
const webhooksClient: DocumentScope<Static<typeof DBWebhook>> =
  client.use('webhooks');
const deletionRequestsClient: DocumentScope<Static<typeof DBDeletionRequest>> =
  client.use('flow_delete_requests');

// Mango index backing timerange queries: segments are looked up by flow_id and
// ordered/filtered on the sortable ts_start key.
export const SEGMENTS_INDEX = {
  ddoc: 'segments-index',
  name: 'flow-ts-start'
};

// Mango index backing object-reclaim lookups: when a Flow or its segments are
// deleted, reclaimObjects checks each candidate object_id for surviving
// references (selector { object_id }). Without this index that check is a full
// scan of the whole segments database per object, making deletion of a Flow
// with many segments O(objects x segments) and unusably slow.
export const SEGMENTS_OBJECT_INDEX = {
  ddoc: 'segments-object-index',
  name: 'object-id'
};

// Mango index backing the deletion worker's status scan: it polls for
// non-terminal requests (selector { status: { $in: ['created', 'started'] } })
// to claim and resume. Without this index that scan is a full database scan of
// flow_delete_requests on every poll.
export const DELETION_REQUESTS_STATUS_INDEX = {
  ddoc: 'delete-requests-status-index',
  name: 'status'
};

const createDbIfMissing = async (name: string) => {
  try {
    await client.db.create(name);
    Logger.black(`Created database: ${name}`);
  } catch (e: unknown) {
    // 412 = database already exists; anything else is a real error.
    if ((e as { statusCode?: number }).statusCode !== 412) {
      throw e;
    }
  }
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Idempotently ensure databases and indexes exist. Run once at startup so the
// gateway works against a fresh CouchDB and stays stateless. Retries with a
// fixed backoff so the gateway tolerates CouchDB coming up after it does.
export const initDatabases = async (retries = 5, delayMs = 2000) => {
  Logger.black('Database: ' + url.toString());
  for (let attempt = 1; ; attempt++) {
    try {
      await createDbIfMissing('flows');
      await createDbIfMissing('sources');
      await createDbIfMissing('segments');
      await createDbIfMissing('webhooks');
      await createDbIfMissing('flow_delete_requests');

      await segmentsClient.createIndex({
        index: { fields: ['flow_id', 'ts_start'] },
        ddoc: SEGMENTS_INDEX.ddoc,
        name: SEGMENTS_INDEX.name,
        type: 'json'
      });
      await segmentsClient.createIndex({
        index: { fields: ['object_id'] },
        ddoc: SEGMENTS_OBJECT_INDEX.ddoc,
        name: SEGMENTS_OBJECT_INDEX.name,
        type: 'json'
      });
      await deletionRequestsClient.createIndex({
        index: { fields: ['status'] },
        ddoc: DELETION_REQUESTS_STATUS_INDEX.ddoc,
        name: DELETION_REQUESTS_STATUS_INDEX.name,
        type: 'json'
      });
      return;
    } catch (e) {
      if (attempt >= retries) {
        throw e;
      }
      Logger.black(
        `Database init failed (attempt ${attempt}/${retries}), retrying in ${delayMs}ms`
      );
      await sleep(delayMs);
    }
  }
};

export {
  client,
  flowsClient,
  sourcesClient,
  segmentsClient,
  webhooksClient,
  deletionRequestsClient
};
