export type Lifecycle =
  | 'OFFLINE'
  | 'START_REQUESTED'
  | 'STARTING'
  | 'RUNNING_UNREADY'
  | 'READY'
  | 'IDLE_COUNTDOWN'
  | 'STOP_REQUESTED'
  | 'STOPPING'
  | 'SUSPENDED'
  | 'BLOCKED'
  | 'API_ERROR'
  | 'UNKNOWN'
  | 'FAILED';

export interface LifecycleInput {
  rawState?: string | null;
  suspended?: boolean;
  blockedReason?: string | null;
  ready?: boolean;
  idle?: boolean;
  failed?: boolean;
}

export function normalizeLifecycle(input: LifecycleInput): Lifecycle {
  if (input.suspended) return 'SUSPENDED';
  if (input.blockedReason) return 'BLOCKED';
  const raw = (input.rawState ?? '').toLowerCase();
  if (raw === 'api_error') return 'API_ERROR';
  if (input.failed) return 'FAILED';
  if (raw === 'offline') return 'OFFLINE';
  if (raw === 'starting') return 'STARTING';
  if (raw === 'stopping') return 'STOPPING';
  if (raw === 'running') {
    if (!input.ready) return 'RUNNING_UNREADY';
    return input.idle ? 'IDLE_COUNTDOWN' : 'READY';
  }
  if (raw === 'start_requested') return 'START_REQUESTED';
  if (raw === 'stop_requested') return 'STOP_REQUESTED';
  return 'UNKNOWN';
}

export function isDispatchable(state: Lifecycle): boolean {
  return state === 'READY' || state === 'IDLE_COUNTDOWN';
}

export function isSafeForAutoStop(state: Lifecycle): boolean {
  return state === 'READY' || state === 'IDLE_COUNTDOWN';
}
