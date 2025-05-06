import nano, { DocumentScope } from 'nano';
import { DBFlow } from './schemas/flows/Flow';
import Logger from '../utils/Logger';
import { Static } from '@sinclair/typebox';
import { DBSource } from './schemas/sources/Source';
import { DBSegments } from './schemas/segments/Segments';

const url = new URL(process.env.DB_URL || 'http://localhost:8000');
url.username = process.env.DB_USERNAME || '';
url.password = process.env.DB_PASSWORD || '';
const client = nano(url.toString());
Logger.black('Database: ' + url.toString());
const flowsClient: DocumentScope<Static<typeof DBFlow>> = client.use('flows');
const sourcesClient: DocumentScope<Static<typeof DBSource>> =
  client.use('sources');
const segmentsClient: DocumentScope<Static<typeof DBSegments>> =
  client.use('segments');

// check if flows, souces etc dbs exist
// if not create them

export { client, flowsClient, sourcesClient, segmentsClient };
