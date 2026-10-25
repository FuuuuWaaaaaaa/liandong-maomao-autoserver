import { describe, expect, it } from 'vitest';
import { normalizeLifecycle } from './lifecycle.js';

describe('生命周期归一化', () => {
  it('不会把 running 当成 ready', () => expect(normalizeLifecycle({ rawState: 'running', ready: false })).toBe('RUNNING_UNREADY'));
  it('识别挂起和阻塞', () => {
    expect(normalizeLifecycle({ rawState: 'offline', suspended: true })).toBe('SUSPENDED');
    expect(normalizeLifecycle({ rawState: 'running', blockedReason: '安装中' })).toBe('BLOCKED');
  });
});
