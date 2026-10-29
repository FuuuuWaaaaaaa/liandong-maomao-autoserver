import type { Store, Target } from './store.js';
import { PterodactylClient, type PterodactylResources } from './pterodactyl.js';
import { probeMinecraft } from './readiness.js';

export interface LifecycleRuntimeOptions {
  pollSeconds: number;
  heartbeatFreshnessSeconds: number;
  readinessProbeTimeoutMs: number;
  autoStopEnabled: boolean;
}

export class LifecycleRuntime {
  private timer?: NodeJS.Timeout;
  private activeTick?: Promise<void>;

  constructor(private readonly store: Store, private readonly pterodactyl: PterodactylClient, private readonly options: LifecycleRuntimeOptions, private readonly log: (message: string, error?: unknown) => void = () => {}) {}

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.options.pollSeconds * 1000);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.activeTick;
  }

  private tick(): Promise<void> {
    if (this.activeTick) return this.activeTick;
    const active = this.runTick();
    this.activeTick = active;
    return active.finally(() => { if (this.activeTick === active) this.activeTick = undefined; });
  }

  private async runTick(): Promise<void> {
    try {
      await this.store.expireTickets();
      for (const target of await this.store.listTargets()) await this.reconcile(target);
    } catch (error) {
      this.log('生命周期轮询失败', error);
    }
  }

  private async reconcile(target: Target): Promise<void> {
    if (!target.panelServerIdentifier || !this.pterodactyl.isConfigured()) return;
    let resources: PterodactylResources;
    try {
      resources = await this.pterodactyl.resources(target.panelServerIdentifier);
    } catch (error) {
      await this.store.updateTargetLifecycle(target.id, 'api_error', false, error instanceof Error ? error.message : 'Pterodactyl 状态请求失败');
      this.log(`读取目标 ${target.id} 的面板状态失败`, error);
      return;
    }

    const rawState = String(resources.current_state ?? 'unknown').toLowerCase();
    const suspended = this.isTrue(resources.is_suspended);
    const blockedReason = this.blockedReason(resources);
    if (suspended || blockedReason) {
      await this.store.updateTargetLifecycle(target.id, rawState, false, blockedReason ?? '服务器已被面板挂起', { suspended, blockedReason });
      return;
    }

    if (target.lifecycle === 'FAILED') return;

    if (rawState !== 'running') {
      const timedOut = this.isStartupTimedOut(target, rawState);
      if (rawState === 'offline' && target.lifecycle === 'START_REQUESTED' && !timedOut) return;
      await this.store.updateTargetLifecycle(target.id, rawState, false, timedOut ? '服务器启动或 Minecraft 就绪超时' : undefined);
      return;
    }

    if (target.lifecycle === 'STOP_REQUESTED' || target.lifecycle === 'STOPPING') return;

    if (target.restartPending) {
      if (this.isStartupTimedOut(target, rawState)) await this.store.updateTargetLifecycle(target.id, rawState, false, '面板未确认重启状态变化，重启超时');
      return;
    }

    const ready = await this.isReady(target);
    if (!ready && this.isStartupTimedOut(target, rawState)) {
      await this.store.updateTargetLifecycle(target.id, rawState, false, '服务器启动或 Minecraft 就绪超时');
      return;
    }
    const freshPresence = this.hasFreshPresence(target);
    const tickets = await this.store.listTickets(target.id);
    const hasDemand = tickets.some((ticket) => ticket.ticketClass === 'online');
    const idle = ready && freshPresence && target.playerCount === 0 && !hasDemand && Boolean(target.zeroSince);
    const idleElapsed = idle ? Date.now() - Date.parse(target.zeroSince!) : 0;

    if (this.options.autoStopEnabled && idle && idleElapsed >= target.idleTimeoutSeconds * 1000) {
      const operationId = await this.store.beginPowerOperation(target.id, 'stop');
      await this.store.updateTargetLifecycle(target.id, 'stop_requested', false);
      try {
        await this.pterodactyl.power(target.panelServerIdentifier, 'stop');
      } catch (error) {
        await this.store.failPowerOperation(operationId, error instanceof Error ? error.message : '自动关服请求失败');
        await this.store.updateTargetLifecycle(target.id, 'api_error', false, error instanceof Error ? error.message : '自动关服请求失败');
        this.log(`自动停止目标 ${target.id} 失败`, error);
      }
      return;
    }
    await this.store.updateTargetLifecycle(target.id, 'running', ready, undefined, { idle });
  }

  private async isReady(target: Target): Promise<boolean> {
    if (this.hasFreshPresence(target) && target.playerCount > 0) return true;
    if (!target.backendHost || !target.backendPort) return false;
    return probeMinecraft(target.backendHost, target.backendPort, this.options.readinessProbeTimeoutMs);
  }

  private hasFreshPresence(target: Target): boolean {
    return Boolean(target.heartbeatAt && Date.now() - Date.parse(target.heartbeatAt) <= this.options.heartbeatFreshnessSeconds * 1000);
  }

  private isStartupTimedOut(target: Target, rawState: string): boolean {
    const activeStart = target.lifecycle === 'START_REQUESTED' || target.lifecycle === 'STARTING' || target.lifecycle === 'RUNNING_UNREADY' || (target.lifecycle === 'API_ERROR' && Boolean(target.startupStartedAt));
    if (!activeStart) return false;
    const waitingForStart = ['starting', 'running', 'start_requested'].includes(rawState) || (rawState === 'offline' && (target.lifecycle === 'START_REQUESTED' || target.lifecycle === 'API_ERROR'));
    if (!waitingForStart) return false;
    const startedAt = target.startupStartedAt ? Date.parse(target.startupStartedAt) : target.updatedAt ? Date.parse(target.updatedAt) : Date.now();
    return Number.isFinite(startedAt) && Date.now() - startedAt >= target.startupTimeoutSeconds * 1000;
  }

  private blockedReason(resources: PterodactylResources): string | undefined {
    const flags: Array<[string, string]> = [
      ['is_installing', '面板正在安装服务器'],
      ['is_transferring', '面板正在迁移服务器'],
      ['is_restoring', '面板正在恢复服务器'],
    ];
    for (const [key, message] of flags) if (this.isTrue(resources[key])) return message;
    return undefined;
  }

  private isTrue(value: unknown): boolean { return value === true || value === 1 || value === '1' || (typeof value === 'string' && value.toLowerCase() === 'true'); }
}
