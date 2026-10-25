import { describe, expect, it } from 'vitest';
import { summarizeTickets, type QueueTicket } from './queue.js';

const ticket = (ticketClass: 'online' | 'offline', sequence: number, playerUuid: string): QueueTicket => ({ id: String(sequence), targetId: 's', playerUuid, ticketClass, state: 'waiting', sequence, createdAt: '', updatedAt: '', expiresAt: new Date(Date.now() + 10000).toISOString() });
describe('双队列', () => {
  it('在线队列独立于离线等待名单', () => {
    const result = summarizeTickets([ticket('offline', 1, '00000000-0000-0000-0000-000000000001'), ticket('online', 2, '00000000-0000-0000-0000-000000000002')], '00000000-0000-0000-0000-000000000002');
    expect(result.online).toEqual({ count: 1, position: 1 });
    expect(result.offline).toEqual({ count: 1, position: undefined });
  });
});
