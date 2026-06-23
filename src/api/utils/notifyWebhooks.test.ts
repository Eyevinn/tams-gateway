import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type Mock
} from 'vitest';

vi.mock('../../db/client', () => ({
  webhooksClient: { find: vi.fn() }
}));

import { webhooksClient } from '../../db/client';
import notifyWebhooks from './notifyWebhooks';

const find = (webhooksClient as unknown as { find: Mock }).find;
let fetchMock: Mock;

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const webhook = (overrides: Record<string, unknown> = {}) => ({
  id: 'wh-1',
  url: 'https://hook.example.com/x',
  events: ['flows/created'],
  status: 'started',
  ...overrides
});

describe('notifyWebhooks', () => {
  it('delivers the spec event body and the api key header to a subscriber', async () => {
    find.mockResolvedValue({
      docs: [webhook({ api_key_name: 'X-Key', api_key_value: 'secret' })]
    });

    await notifyWebhooks(
      'flows/created',
      { flow: { id: 'f-1' } },
      {
        flowId: 'f-1'
      }
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://hook.example.com/x');
    expect(init.method).toBe('POST');
    const sent = JSON.parse(init.body);
    expect(sent.event_type).toBe('flows/created');
    expect(sent.event.flow.id).toBe('f-1');
    expect(typeof sent.event_timestamp).toBe('string');
    expect(init.headers['X-Key']).toBe('secret');
  });

  it('does not deliver an event the webhook is not subscribed to', async () => {
    find.mockResolvedValue({ docs: [webhook({ events: ['flows/updated'] })] });

    await notifyWebhooks(
      'flows/created',
      { flow: { id: 'f-1' } },
      {
        flowId: 'f-1'
      }
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('applies the flow_ids delivery filter', async () => {
    find.mockResolvedValue({ docs: [webhook({ flow_ids: ['other-flow'] })] });

    await notifyWebhooks(
      'flows/created',
      { flow: { id: 'f-1' } },
      {
        flowId: 'f-1'
      }
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses to deliver to the cloud metadata address (SSRF guard)', async () => {
    find.mockResolvedValue({
      docs: [webhook({ url: 'http://169.254.169.254/latest/meta-data' })]
    });

    await notifyWebhooks(
      'flows/created',
      { flow: { id: 'f-1' } },
      {
        flowId: 'f-1'
      }
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never throws when the webhook query fails', async () => {
    find.mockRejectedValue(new Error('db down'));

    await expect(
      notifyWebhooks(
        'flows/created',
        { flow: { id: 'f-1' } },
        { flowId: 'f-1' }
      )
    ).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never throws when delivery fails', async () => {
    find.mockResolvedValue({ docs: [webhook()] });
    fetchMock.mockRejectedValue(new Error('connection refused'));

    await expect(
      notifyWebhooks(
        'flows/created',
        { flow: { id: 'f-1' } },
        { flowId: 'f-1' }
      )
    ).resolves.toBeUndefined();
  });
});
