import { afterEach, describe, expect, it } from 'vitest';
import { LifecycleRuntime } from './lifecycle-runtime.js';
import { MemoryStore } from './store.js';
import type { PterodactylClient } from './pterodactyl.js';

const runtimes: LifecycleRuntime[] = [];

afterEach(async () => { await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop())); });

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(check()).toBe(true);
}

describe('生命周期运行时', () => {
  it('在冷启动超时后保留面板原始状态并保持 FAILED', async () => {
    const store = new MemoryStore(new Map());
    const target = await store.createTarget({
      id: 'slow-server',
      slug: 'slow-server',
      displayName: '慢速服务器',
      aliases: ['slow.example.com'],
      panelServerIdentifier: 'panel-id',
      startupTimeoutSeconds: 30,
    });
    await store.wakeTarget('slow-server', 'request-1');
    target!.startupStartedAt = new Date(Date.now() - 31_000).toISOString();
    const panel = { isConfigured: () => true, resources: async () => ({ current_state: 'offline' }) } as unknown as PterodactylClient;
    const runtime = new LifecycleRuntime(store, panel, { pollSeconds: 60, heartbeatFreshnessSeconds: 45, readinessProbeTimeoutMs: 100, autoStopEnabled: false });
    runtimes.push(runtime);
    runtime.start();
    await waitFor(() => target?.lifecycle === 'FAILED');

    expect(target?.rawState).toBe('offline');
    expect(target?.lastError).toContain('超时');
  });

  it('状态接口短暂报错不会重置启动超时', async () => {
    const store = new MemoryStore(new Map());
    const target = await store.createTarget({
      id: 'recovering-server',
      slug: 'recovering-server',
      displayName: '状态恢复服务器',
      aliases: ['recovering.example.com'],
      panelServerIdentifier: 'panel-id',
      startupTimeoutSeconds: 30,
    });
    await store.wakeTarget('recovering-server', 'request-1');
    target!.startupStartedAt = new Date(Date.now() - 31_000).toISOString();
    await store.updateTargetLifecycle('recovering-server', 'api_error', false, '临时错误');
    const panel = { isConfigured: () => true, resources: async () => ({ current_state: 'running' }) } as unknown as PterodactylClient;
    const runtime = new LifecycleRuntime(store, panel, { pollSeconds: 60, heartbeatFreshnessSeconds: 45, readinessProbeTimeoutMs: 100, autoStopEnabled: false });
    runtimes.push(runtime);
    runtime.start();
    await waitFor(() => target?.lifecycle === 'FAILED');

    expect(target?.rawState).toBe('running');
    expect(target?.lastError).toContain('超时');
  });

  it('重启请求后仍报告 running 时不会把旧服务判为就绪', async () => {
    const store = new MemoryStore(new Map());
    const target = await store.createTarget({ id: 'restart-server', slug: 'restart-server', displayName: '重启服务器', aliases: ['restart.example.com'] });
    await store.updateTargetLifecycle('restart-server', 'running', true);
    await store.beginPowerOperation('restart-server', 'restart');
    await store.updateTargetLifecycle('restart-server', 'start_requested', false);
    const panel = { isConfigured: () => true, resources: async () => ({ current_state: 'running' }) } as unknown as PterodactylClient;
    const runtime = new LifecycleRuntime(store, panel, { pollSeconds: 60, heartbeatFreshnessSeconds: 45, readinessProbeTimeoutMs: 100, autoStopEnabled: false });
    runtimes.push(runtime);
    runtime.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(target?.lifecycle).toBe('START_REQUESTED');
    expect(target?.ready).toBe(false);
  });
});
