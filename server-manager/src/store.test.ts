import { describe, expect, it } from 'vitest';
import { MemoryStore } from './store.js';

describe('代理凭证管理', () => {
  it('创建代理后可以用生成的令牌认证，列表不会返回完整令牌', async () => {
    const store = new MemoryStore(new Map());
    const created = await store.createProxy({ id: 'proxy-test', name: '测试代理', token: 'first-token' });
    expect(created?.id).toBe('proxy-test');
    expect(created).not.toHaveProperty('token');
    expect(await store.authenticateProxy('first-token')).toBe('proxy-test');
    expect((await store.listProxies())[0]).not.toHaveProperty('token');
  });

  it('轮换令牌后旧令牌失效', async () => {
    const store = new MemoryStore(new Map([['proxy-test', 'first-token']]));
    await store.rotateProxyToken('proxy-test', 'second-token');
    expect(await store.authenticateProxy('first-token')).toBeUndefined();
    expect(await store.authenticateProxy('second-token')).toBe('proxy-test');
  });

  it('没有目标服务器时，心跳仍会更新代理最近连接时间', async () => {
    const store = new MemoryStore(new Map([['proxy-test', 'first-token']]));
    const observedAt = '2026-10-30T04:17:57.000Z';
    await store.touchProxy('proxy-test', observedAt);
    expect((await store.listProxies())[0]?.lastSeenAt).toBe(observedAt);
  });

  it('可以创建目标服务器并按域名查找', async () => {
    const store = new MemoryStore(new Map());
    const created = await store.createTarget({ id: 'server-test', slug: 'server-test', displayName: '测试服务器', aliases: ['play.example.com'], entryProfile: 'default-lobby' });
    expect(created?.lifecycle).toBe('OFFLINE');
    expect((await store.findTargetByHostname('PLAY.EXAMPLE.COM.'))?.id).toBe('server-test');
  });

  it('更新目标时同步更换域名，且不会覆盖其他目标的路由', async () => {
    const store = new MemoryStore(new Map());
    await store.createTarget({ id: 'server-a', slug: 'server-a', displayName: 'A', aliases: ['a.example.com'] });
    await store.createTarget({ id: 'server-b', slug: 'server-b', displayName: 'B', aliases: ['b.example.com'] });
    const updated = await store.updateTarget('server-a', { id: 'server-a', slug: 'server-a', displayName: 'A2', aliases: ['a2.example.com'] });
    expect(updated?.displayName).toBe('A2');
    expect(await store.findTargetByHostname('a.example.com')).toBeUndefined();
    expect((await store.findTargetByHostname('a2.example.com'))?.id).toBe('server-a');
    expect((await store.findTargetByHostname('b.example.com'))?.id).toBe('server-b');
    expect(await store.updateTarget('server-a', { id: 'server-a', slug: 'server-a', displayName: 'Conflict', aliases: ['b.example.com'] })).toBeUndefined();
  });

  it('删除目标会清理对应域名和活动票据', async () => {
    const store = new MemoryStore(new Map());
    const target = await store.createTarget({ id: 'server-delete', slug: 'server-delete', displayName: '待删除', aliases: ['delete.example.com'] });
    await store.upsertTicket({ targetId: target!.id, playerUuid: '550e8400-e29b-41d4-a716-446655440099', ticketClass: 'offline' });
    expect(await store.deleteTarget(target!.id)).toBe(true);
    expect(await store.getTarget(target!.id)).toBeUndefined();
    expect(await store.findTargetByHostname('delete.example.com')).toBeUndefined();
    expect(await store.listTickets(target!.id)).toHaveLength(0);
    expect(await store.deleteTarget(target!.id)).toBe(false);
  });

  it('同一唤醒只发起一次，服务器再次离线后允许新会话唤醒', async () => {
    const store = new MemoryStore(new Map());
    const first = await store.wakeTarget('survival', 'session-1');
    const duplicate = await store.wakeTarget('survival', 'session-2');
    expect(first.shouldPower).toBe(true);
    expect(duplicate.shouldPower).toBe(false);

    await store.updateTargetLifecycle('survival', 'offline', false);
    const next = await store.wakeTarget('survival', 'session-3');
    expect(next.shouldPower).toBe(true);
  });

  it('停止信号已发出时不并发发送启动信号', async () => {
    const store = new MemoryStore(new Map());
    await store.updateTargetLifecycle('survival', 'stop_requested', false);
    const wake = await store.wakeTarget('survival', 'during-stop');
    expect(wake.accepted).toBe(false);
    expect(wake.shouldPower).toBe(false);
    expect(wake.reason).toBe('STOP_REQUESTED');
  });

  it('重启请求发出后，旧的 running 状态不会被立刻当成就绪', async () => {
    const store = new MemoryStore(new Map());
    await store.updateTargetLifecycle('survival', 'running', true);
    await store.beginPowerOperation('survival', 'restart');
    await store.updateTargetLifecycle('survival', 'start_requested', false);
    const target = await store.getTarget('survival');
    expect(target?.restartPending).toBe(true);
    expect(target?.lifecycle).toBe('START_REQUESTED');
    await store.updateTargetLifecycle('survival', 'starting', false);
    expect((await store.getTarget('survival'))?.restartPending).toBe(false);
  });

  it('管理器请求状态不会覆盖面板原始状态，旧事件不能覆盖完成的票据', async () => {
    const store = new MemoryStore(new Map());
    await store.updateTargetLifecycle('survival', 'start_requested', false);
    await store.updateTargetLifecycle('survival', 'api_error', false, '面板暂不可用');
    expect((await store.getTarget('survival'))?.rawState).toBe('offline');

    const ticket = await store.upsertTicket({ targetId: 'survival', playerUuid: '550e8400-e29b-41d4-a716-446655440000', ticketClass: 'online' });
    await store.updateTicketEvent('survival', ticket.id, 'transferred');
    await store.updateTicketEvent('survival', ticket.id, 'failed');
    expect((await store.listTickets('survival'))).toHaveLength(0);
    expect((await store.upsertTicket({ targetId: 'survival', playerUuid: ticket.playerUuid, ticketClass: 'offline' })).id).not.toBe(ticket.id);
  });

  it('刷新票据时按配置延长有效期', async () => {
    const store = new MemoryStore(new Map());
    const playerUuid = '550e8400-e29b-41d4-a716-446655440001';
    const first = await store.upsertTicket({ targetId: 'survival', playerUuid, ticketClass: 'offline', ttlSeconds: 60 });
    const firstExpiresAt = Date.parse(first.expiresAt);
    const refreshed = await store.upsertTicket({ targetId: 'survival', playerUuid, ticketClass: 'offline', ttlSeconds: 3600 });
    expect(refreshed.id).toBe(first.id);
    expect(Date.parse(refreshed.expiresAt)).toBeGreaterThan(firstExpiresAt);
  });

  it('可以按玩家 UUID 找到活动离线票据', async () => {
    const store = new MemoryStore(new Map());
    const playerUuid = '550e8400-e29b-41d4-a716-446655440004';
    const created = await store.upsertTicket({ targetId: 'survival', playerUuid, ticketClass: 'offline' });
    expect((await store.findActiveTicket('survival', playerUuid))?.id).toBe(created.id);
    await store.updateTicketEvent('survival', created.id, 'expired');
    expect(await store.findActiveTicket('survival', playerUuid)).toBeUndefined();
  });

  it('活动票据按 TTL 过期，在线队列可以通过重复上报续期', async () => {
    const store = new MemoryStore(new Map());
    const playerUuid = '550e8400-e29b-41d4-a716-446655440002';
    const online = await store.upsertTicket({ targetId: 'survival', playerUuid, ticketClass: 'online', ttlSeconds: 60 });
    await store.upsertTicket({ targetId: 'survival', playerUuid, ticketClass: 'online', ttlSeconds: 3600 });
    expect((await store.listTickets('survival')).some((ticket) => ticket.id === online.id)).toBe(true);
    expect(await store.expireTickets(new Date(Date.now() + 120_000))).toBe(0);

    const offline = await store.upsertTicket({ targetId: 'survival', playerUuid: '550e8400-e29b-41d4-a716-446655440003', ticketClass: 'offline', ttlSeconds: 60 });
    expect(await store.expireTickets(new Date(Date.now() + 120_000))).toBe(1);
    expect((await store.listTickets('survival')).some((ticket) => ticket.id === offline.id)).toBe(false);
  });

  it('未知质量心跳不会把玩家数误报为零', async () => {
    const store = new MemoryStore(new Map());
    await store.saveHeartbeat('proxy-main', 'survival', 0, new Date().toISOString(), 'unknown');
    expect((await store.getTarget('survival'))?.heartbeatAt).toBeUndefined();
  });

  it('心跳中断后重新收到零玩家会重新开始空闲计时', async () => {
    const store = new MemoryStore(new Map());
    const first = new Date(Date.now() - 120_000).toISOString();
    const second = new Date().toISOString();
    await store.updateTargetLifecycle('survival', 'running', true);
    await store.saveHeartbeat('proxy-main', 'survival', 0, first, 'fresh', 45);
    await store.saveHeartbeat('proxy-main', 'survival', 0, second, 'fresh', 45);
    expect((await store.getTarget('survival'))?.zeroSince).toBe(second);
  });

  it('乱序心跳不会倒退玩家数或最近观测时间', async () => {
    const store = new MemoryStore(new Map());
    const newer = new Date().toISOString();
    const older = new Date(Date.now() - 10_000).toISOString();
    await store.saveHeartbeat('proxy-main', 'survival', 3, newer, 'fresh');
    await store.saveHeartbeat('proxy-main', 'survival', 0, older, 'fresh');
    const target = await store.getTarget('survival');
    expect(target?.playerCount).toBe(3);
    expect(target?.heartbeatAt).toBe(newer);
  });

  it('离线期间的零玩家心跳不会提前累计空闲时间', async () => {
    const store = new MemoryStore(new Map());
    const first = new Date(Date.now() - 60_000).toISOString();
    const second = new Date().toISOString();
    await store.saveHeartbeat('proxy-main', 'survival', 0, first);
    expect((await store.getTarget('survival'))?.zeroSince).toBeUndefined();
    await store.updateTargetLifecycle('survival', 'running', true);
    await store.saveHeartbeat('proxy-main', 'survival', 0, second);
    expect((await store.getTarget('survival'))?.zeroSince).toBe(second);
    await store.updateTargetLifecycle('survival', 'api_error', false, '状态暂不可用');
    expect((await store.getTarget('survival'))?.zeroSince).toBeUndefined();
  });
});
