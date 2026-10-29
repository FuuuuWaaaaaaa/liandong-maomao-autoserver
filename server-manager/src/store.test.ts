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
});
