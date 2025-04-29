import nano, { DocumentScope } from 'nano';
import { DBFlow } from './schemas/Flow';
import Logger from '../utils/Logger';
import { Static } from '@sinclair/typebox';

const url = new URL(process.env.DB_URL || 'http://localhost:8000');
url.username = process.env.DB_USERNAME || '';
url.password = process.env.DB_PASSWORD || '';
const client = nano(url.toString());
Logger.black('Database: ' + url.toString());
const flowsClient: DocumentScope<Static<typeof DBFlow>> = client.use('flows');

// check if flows, souces etc dbs exist
// if not create them

export { client, flowsClient };
