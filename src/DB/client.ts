import nano, { DocumentScope } from 'nano';
import Flow from './schemas/flow';
import Logger from '../utils/Logger';

const url = new URL(process.env.DB_URL || 'http://localhost:8000');
url.username = process.env.DB_USERNAME || '';
url.password = process.env.DB_PASSWORD || '';
const client = nano(url.toString());
Logger.black('Database: ' + url.toString());
const flowsClient: DocumentScope<Flow> = client.use('flows');

// check if flows, souces etc dbs exist
// if not create them

export { client, flowsClient };
