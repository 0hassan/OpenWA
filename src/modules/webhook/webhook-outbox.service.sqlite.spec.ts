import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { Session } from '../session/entities/session.entity';
import { Webhook } from './entities/webhook.entity';
import { WebhookDeliveryFailure } from './entities/webhook-delivery-failure.entity';
import { WebhookOutboxEvent } from './entities/webhook-outbox-event.entity';
import { WebhookOutboxService } from './webhook-outbox.service';
import { recordWebhookDeliveryFailure } from './utils/record-delivery-failure';

// SQLite serves every repository from one connection, so a transaction a write opens is shared with the
// writes that run while it is open. A re-dispatched key makes open() hit the unique violation it expects.
describe('WebhookOutboxService.open() against a concurrent write (SQLite)', () => {
  let ds: DataSource;

  beforeEach(async () => {
    ds = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Session, Webhook, WebhookDeliveryFailure, WebhookOutboxEvent],
      synchronize: true,
    }).initialize();
  });
  afterEach(() => ds.destroy());

  it('does not undo a delivery failure recorded while a duplicate key is rejected', async () => {
    const outbox = new WebhookOutboxService(ds.getRepository(WebhookOutboxEvent));
    const failures = ds.getRepository(WebhookDeliveryFailure);
    const logger = { error: jest.fn() };
    const lost: number[] = [];

    for (let i = 0; i < 20; i++) {
      const row = { webhookId: 'w1', sessionId: 's1', event: 'message.ack', deliveryId: `d${i}`, payload: { i } };
      await outbox.open({ ...row, idempotencyKey: `ack_${i}` });

      const duplicate = outbox.open({ ...row, idempotencyKey: `ack_${i}`, deliveryId: `d${i}b` });
      const recorded = recordWebhookDeliveryFailure(failures, logger, {
        webhookId: 'w1',
        sessionId: 's1',
        event: 'message.received',
        url: 'https://a.example',
        idempotencyKey: `other_${i}`,
        deliveryId: `x${i}`,
        attempts: 3,
        lastStatusCode: 503,
        lastError: 'HTTP 503',
      });
      const [, result] = await Promise.all([duplicate, recorded]);

      // The recorder answered that the row is durable, so it must be there.
      if (result !== null && (await failures.count({ where: { idempotencyKey: `other_${i}` } })) === 0) lost.push(i);
    }

    expect(lost).toEqual([]);
  });
});
