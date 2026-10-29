import { createHash, randomUUID } from 'node:crypto';
import mysql, { type Pool } from 'mysql2/promise';
import type { Lifecycle } from './domain/lifecycle.js';
import { normalizeLifecycle } from './domain/lifecycle.js';
import type { QueueTicket, TicketClass, TicketState } from './domain/queue.js';

export interface Target {
  id: string;
  slug: string;
  displayName: string;
  aliases: string[];
  rawState: string;
  lifecycle: Lifecycle;
  ready: boolean;
  enabled: boolean;
  playerCount: number;
  heartbeatAt?: string;
  zeroSince?: string;
  lastError?: string;
  updatedAt?: string;
  startupStartedAt?: string;
  restartPending?: boolean;
  startupTimeoutSeconds: number;
  idleTimeoutSeconds: number;
  panelServerIdentifier?: string;
  backendHost?: string;
  backendPort?: number;
  software?: string;
  loader?: string;
  minecraftVersion?: string;
  entryProfile?: string;
}

export interface TargetInput {
  id: string;
  slug: string;
  displayName: string;
  aliases: string[];
  panelServerIdentifier?: string;
  backendHost?: string;
  backendPort?: number;
  software?: string;
  loader?: string;
  minecraftVersion?: string;
  entryProfile?: string;
  startupTimeoutSeconds?: number;
  idleTimeoutSeconds?: number;
}

export interface WakeResult {
  target: Target;
  operationId?: string;
  accepted: boolean;
  shouldPower?: boolean;
  reason?: string;
}

export interface ProxySummary {
  id: string;
  name: string;
  tokenHint?: string;
  enabled: boolean;
  lastSeenAt?: string;
  pluginVersion?: string;
  apiVersion?: string;
}

export interface Store {
  close(): Promise<void>;
  listTargets(): Promise<Target[]>;
  createTarget(input: TargetInput): Promise<Target | undefined>;
  updateTarget(id: string, input: TargetInput): Promise<Target | undefined>;
  deleteTarget(id: string): Promise<boolean>;
  beginPowerOperation(targetId: string, signal: 'start' | 'stop' | 'restart'): Promise<string>;
  failPowerOperation(operationId: string, error: string): Promise<void>;
  getTarget(id: string): Promise<Target | undefined>;
  findTargetByHostname(hostname: string): Promise<Target | undefined>;
  wakeTarget(id: string, idempotencyKey: string): Promise<WakeResult>;
  updateTargetLifecycle(id: string, rawState: string, ready: boolean, error?: string, options?: { suspended?: boolean; blockedReason?: string; idle?: boolean }): Promise<Target | undefined>;
  saveHeartbeat(proxyId: string, targetId: string, count: number, observedAt: string, quality?: string, freshnessSeconds?: number): Promise<void>;
  upsertTicket(input: { targetId: string; playerUuid: string; playerName?: string; ticketClass: TicketClass; snapshot?: string; ttlSeconds?: number }): Promise<QueueTicket>;
  findActiveTicket(targetId: string, playerUuid: string): Promise<QueueTicket | undefined>;
  updateTicketEvent(targetId: string, ticketId: string, event: string, snapshot?: string): Promise<QueueTicket | undefined>;
  listTickets(targetId: string): Promise<QueueTicket[]>;
  expireTickets(now?: Date): Promise<number>;
  authenticateProxy(token: string): Promise<string | undefined>;
  touchProxy(proxyId: string, observedAt: string, pluginVersion?: string, apiVersion?: string): Promise<void>;
  listProxies(): Promise<ProxySummary[]>;
  createProxy(input: { id: string; name: string; token: string }): Promise<ProxySummary | undefined>;
  rotateProxyToken(id: string, token: string): Promise<ProxySummary | undefined>;
}

function normalizeHostname(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '');
}

function ticketExpiresAt(ttlSeconds = 1800): Date {
  return new Date(Date.now() + ttlSeconds * 1000);
}

function newTicket(input: { targetId: string; playerUuid: string; playerName?: string; ticketClass: TicketClass; sequence: number; snapshot?: string; ttlSeconds?: number }): QueueTicket {
  const now = new Date();
  return { id: randomUUID(), targetId: input.targetId, playerUuid: input.playerUuid, playerName: input.playerName, ticketClass: input.ticketClass, state: input.ticketClass === 'online' ? 'promoted' : 'waiting', sequence: input.sequence, createdAt: now.toISOString(), updatedAt: now.toISOString(), expiresAt: ticketExpiresAt(input.ttlSeconds).toISOString(), lastSnapshot: input.snapshot };
}

export class MemoryStore implements Store {
  private readonly proxyTokens: Map<string, string>;
  private readonly targets = new Map<string, Target>();
  private readonly tickets = new Map<string, QueueTicket>();
  private readonly heartbeats = new Map<string, { count: number; observedAt: string }>();
  private sequence = 0;
  private readonly operations = new Map<string, { id: string; targetId: string; key: string; operation: 'start' | 'stop' | 'restart' }>();
  private readonly proxies = new Map<string, ProxySummary>();

  constructor(proxyTokens: Map<string, string>) {
    this.proxyTokens = proxyTokens;
    for (const [id, token] of proxyTokens) this.proxies.set(id, { id, name: id, tokenHint: `****${token.slice(-4)}`, enabled: true });
    this.targets.set('survival', { id: 'survival', slug: 'survival', displayName: '生存世界', aliases: ['survival.example.net', '生存.example.net'], rawState: 'offline', lifecycle: 'OFFLINE', ready: false, enabled: true, playerCount: 0, updatedAt: new Date().toISOString(), startupTimeoutSeconds: 300, idleTimeoutSeconds: 900, panelServerIdentifier: 'survival' , backendHost: '127.0.0.1', backendPort: 25565, software: 'Paper', loader: 'Paper', minecraftVersion: '1.21.1', entryProfile: 'default-lobby' });
    for (const [id] of proxyTokens) {
      void id;
    }
  }

  async close(): Promise<void> {}
  async authenticateProxy(token: string): Promise<string | undefined> { return [...this.proxyTokens.entries()].find(([, configured]) => configured === token)?.[0]; }
  async touchProxy(proxyId: string, observedAt: string, pluginVersion?: string, apiVersion?: string): Promise<void> {
    const proxy = this.proxies.get(proxyId);
    if (proxy) this.proxies.set(proxyId, { ...proxy, lastSeenAt: observedAt, pluginVersion: pluginVersion ?? proxy.pluginVersion, apiVersion: apiVersion ?? proxy.apiVersion });
  }
  async listProxies(): Promise<ProxySummary[]> { return [...this.proxies.values()]; }
  async createProxy(input: { id: string; name: string; token: string }): Promise<ProxySummary | undefined> { if (this.proxies.has(input.id)) return undefined; this.proxyTokens.set(input.id, input.token); const proxy = { id: input.id, name: input.name, tokenHint: `****${input.token.slice(-4)}`, enabled: true }; this.proxies.set(input.id, proxy); return proxy; }
  async rotateProxyToken(id: string, token: string): Promise<ProxySummary | undefined> { const proxy = this.proxies.get(id); if (!proxy) return undefined; this.proxyTokens.set(id, token); const updated = { ...proxy, tokenHint: `****${token.slice(-4)}` }; this.proxies.set(id, updated); return updated; }
  async listTargets(): Promise<Target[]> { return [...this.targets.values()]; }
  async createTarget(input: TargetInput): Promise<Target | undefined> {
    if (this.targets.has(input.id) || [...this.targets.values()].some((target) => target.slug === input.slug || input.aliases.some((alias) => target.aliases.map(normalizeHostname).includes(normalizeHostname(alias))))) return undefined;
    const target: Target = { ...input, rawState: 'offline', lifecycle: 'OFFLINE', ready: false, enabled: true, playerCount: 0, updatedAt: new Date().toISOString(), startupTimeoutSeconds: input.startupTimeoutSeconds ?? 300, idleTimeoutSeconds: input.idleTimeoutSeconds ?? 900 };
    this.targets.set(target.id, target);
    return target;
  }
  async updateTarget(id: string, input: TargetInput): Promise<Target | undefined> {
    const current = this.targets.get(id);
    if (!current || [...this.targets.values()].some((target) => target.id !== id && (target.slug === input.slug || input.aliases.some((alias) => target.aliases.map(normalizeHostname).includes(normalizeHostname(alias)))))) return undefined;
    Object.assign(current, input, { id, startupTimeoutSeconds: input.startupTimeoutSeconds ?? current.startupTimeoutSeconds ?? 300, idleTimeoutSeconds: input.idleTimeoutSeconds ?? current.idleTimeoutSeconds ?? 900, updatedAt: new Date().toISOString() });
    return current;
  }
  async deleteTarget(id: string): Promise<boolean> {
    if (!this.targets.delete(id)) return false;
    for (const [ticketId, ticket] of this.tickets) if (ticket.targetId === id) this.tickets.delete(ticketId);
    this.heartbeats.delete(id);
    return true;
  }
  async getTarget(id: string): Promise<Target | undefined> { return this.targets.get(id); }
  async beginPowerOperation(targetId: string, signal: 'start' | 'stop' | 'restart'): Promise<string> {
    const operationId = randomUUID();
    this.operations.set(`manual:${operationId}`, { id: operationId, targetId, key: `manual:${signal}`, operation: signal });
    const target = this.targets.get(targetId);
    if (target && (signal === 'start' || signal === 'restart')) target.startupStartedAt = new Date().toISOString();
    if (target && signal === 'restart') target.restartPending = true;
    return operationId;
  }
  async failPowerOperation(operationId: string, _error: string): Promise<void> {
    for (const [key, operation] of this.operations) {
      if (operation.id !== operationId) continue;
      this.operations.delete(key);
      const target = this.targets.get(operation.targetId);
      if (target && (operation.operation === 'start' || operation.operation === 'restart')) target.startupStartedAt = undefined;
      if (target && operation.operation === 'restart') target.restartPending = false;
    }
  }
  async findTargetByHostname(hostname: string): Promise<Target | undefined> {
    const normalized = normalizeHostname(hostname);
    return [...this.targets.values()].find((target) => target.aliases.map(normalizeHostname).includes(normalized));
  }
  async wakeTarget(id: string, idempotencyKey: string): Promise<WakeResult> {
    const target = this.targets.get(id);
    if (!target) return { accepted: false, reason: 'TARGET_NOT_FOUND', target: undefined as never };
    if (target.lifecycle === 'READY' || target.lifecycle === 'IDLE_COUNTDOWN') return { accepted: true, target, shouldPower: false };
    if (target.lifecycle === 'STARTING' || target.lifecycle === 'START_REQUESTED' || target.lifecycle === 'RUNNING_UNREADY') return { accepted: true, target, shouldPower: false, operationId: [...this.operations.values()].find((x) => x.targetId === id)?.id };
    if (target.lifecycle === 'STOP_REQUESTED' || target.lifecycle === 'STOPPING' || target.lifecycle === 'SUSPENDED' || target.lifecycle === 'BLOCKED' || target.lifecycle === 'API_ERROR') return { accepted: false, target, shouldPower: false, reason: target.lifecycle };
    const existing = this.operations.get(`${id}:${idempotencyKey}`);
    if (existing) return { accepted: true, target: this.targets.get(id)!, shouldPower: false, operationId: existing.id };
    target.lifecycle = 'START_REQUESTED'; target.lastError = undefined; target.updatedAt = new Date().toISOString(); target.startupStartedAt = target.updatedAt;
    const operationId = randomUUID();
    this.operations.set(`${id}:${idempotencyKey}`, { id: operationId, targetId: id, key: idempotencyKey, operation: 'start' });
    return { accepted: true, target, shouldPower: true, operationId };
  }
  async updateTargetLifecycle(id: string, rawState: string, ready: boolean, error?: string, options?: { suspended?: boolean; blockedReason?: string; idle?: boolean }): Promise<Target | undefined> {
    const target = this.targets.get(id); if (!target) return undefined;
    const wasRunning = target.rawState === 'running';
    const lifecycle = normalizeLifecycle({ rawState, ready, failed: Boolean(error), suspended: options?.suspended, blockedReason: options?.blockedReason, idle: options?.idle });
    const syntheticState = ['start_requested', 'stop_requested', 'api_error'].includes(rawState);
    if ((!syntheticState && target.rawState !== rawState) || target.ready !== ready || target.lastError !== error || target.lifecycle !== lifecycle) target.updatedAt = new Date().toISOString();
    if (!syntheticState) target.rawState = rawState;
    target.ready = syntheticState ? false : ready; target.lastError = error; target.lifecycle = lifecycle;
    if (syntheticState || rawState !== 'running' || !ready || !wasRunning) target.zeroSince = undefined;
    if (!syntheticState && rawState !== 'running') target.restartPending = false;
    if (['READY', 'IDLE_COUNTDOWN', 'FAILED', 'OFFLINE'].includes(lifecycle)) target.startupStartedAt = undefined;
    return target;
  }
  async saveHeartbeat(_proxyId: string, targetId: string, count: number, observedAt: string, quality = 'fresh', freshnessSeconds = 45): Promise<void> {
    this.heartbeats.set(targetId, { count, observedAt });
    const target = this.targets.get(targetId); if (!target) return;
    if (quality !== 'fresh') return;
    const previousHeartbeat = target.heartbeatAt ? Date.parse(target.heartbeatAt) : Number.NaN;
    const observed = Date.parse(observedAt);
    if (Number.isFinite(previousHeartbeat) && (!Number.isFinite(observed) || observed <= previousHeartbeat)) return;
    target.playerCount = count; target.heartbeatAt = observedAt;
    if (count === 0 && target.rawState === 'running' && target.ready && (target.zeroSince === undefined || !Number.isFinite(previousHeartbeat) || observed - previousHeartbeat > freshnessSeconds * 1000)) target.zeroSince = observedAt;
    if (count > 0 || target.rawState !== 'running' || !target.ready) target.zeroSince = undefined;
  }
  async upsertTicket(input: { targetId: string; playerUuid: string; playerName?: string; ticketClass: TicketClass; snapshot?: string; ttlSeconds?: number }): Promise<QueueTicket> {
    const existing = [...this.tickets.values()].find((ticket) => ticket.targetId === input.targetId && ticket.playerUuid === input.playerUuid && ['waiting', 'promoted'].includes(ticket.state) && new Date(ticket.expiresAt).getTime() > Date.now());
    if (existing) { existing.ticketClass = input.ticketClass; existing.state = input.ticketClass === 'online' ? 'promoted' : 'waiting'; existing.playerName = input.playerName ?? existing.playerName; existing.updatedAt = new Date().toISOString(); existing.expiresAt = ticketExpiresAt(input.ttlSeconds).toISOString(); existing.lastSnapshot = input.snapshot ?? existing.lastSnapshot; return existing; }
    const ticket = newTicket({ ...input, sequence: ++this.sequence }); this.tickets.set(ticket.id, ticket); return ticket;
  }
  async findActiveTicket(targetId: string, playerUuid: string): Promise<QueueTicket | undefined> { return [...this.tickets.values()].find((ticket) => ticket.targetId === targetId && ticket.playerUuid === playerUuid && ['waiting', 'promoted'].includes(ticket.state) && new Date(ticket.expiresAt).getTime() > Date.now()); }
  async updateTicketEvent(targetId: string, ticketId: string, event: string, snapshot?: string): Promise<QueueTicket | undefined> {
    const ticket = this.tickets.get(ticketId); if (!ticket || ticket.targetId !== targetId) return undefined;
    const state: TicketState | undefined = ({ promoted: 'promoted', transferred: 'transferred', failed: 'failed', expired: 'expired' } as Record<string, TicketState>)[event];
    if (state && ['waiting', 'promoted'].includes(ticket.state)) {
      ticket.state = state;
      ticket.updatedAt = new Date().toISOString();
      ticket.lastSnapshot = snapshot ?? ticket.lastSnapshot;
    }
    return ticket;
  }
  async listTickets(targetId: string): Promise<QueueTicket[]> { return [...this.tickets.values()].filter((ticket) => ticket.targetId === targetId && ['waiting', 'promoted'].includes(ticket.state) && new Date(ticket.expiresAt).getTime() > Date.now()).sort((a, b) => a.sequence - b.sequence); }
  async expireTickets(now = new Date()): Promise<number> { let count = 0; for (const ticket of this.tickets.values()) if (['waiting', 'promoted'].includes(ticket.state) && new Date(ticket.expiresAt) <= now) { ticket.state = 'expired'; ticket.updatedAt = now.toISOString(); count++; } return count; }
}

export class MysqlStore implements Store {
  private constructor(private readonly pool: Pool) {}
  static async connect(url: string): Promise<MysqlStore> { const pool = mysql.createPool(url); await pool.query('SELECT 1'); return new MysqlStore(pool); }
  async close(): Promise<void> { await this.pool.end(); }
  async authenticateProxy(token: string): Promise<string | undefined> { const [rows] = await this.pool.query<any[]>('SELECT id FROM proxy_instances WHERE token_hash=? AND enabled=1 LIMIT 1', [hashToken(token)]); return rows[0]?.id; }
  async touchProxy(proxyId: string, observedAt: string, pluginVersion?: string, apiVersion?: string): Promise<void> { await this.pool.query('UPDATE proxy_instances SET last_seen_at=?,plugin_version=COALESCE(?,plugin_version),api_version=COALESCE(?,api_version) WHERE id=? AND enabled=1', [new Date(observedAt), pluginVersion ?? null, apiVersion ?? null, proxyId]); }
  async listProxies(): Promise<ProxySummary[]> { const [rows] = await this.pool.query<any[]>('SELECT id,name,token_hint,enabled,last_seen_at,plugin_version,api_version FROM proxy_instances ORDER BY name'); return rows.map(rowToProxy); }
  async createProxy(input: { id: string; name: string; token: string }): Promise<ProxySummary | undefined> { try { await this.pool.query('INSERT INTO proxy_instances (id,name,token_hash,token_hint,enabled) VALUES (?,?,?,?,1)', [input.id, input.name, hashToken(input.token), `****${input.token.slice(-4)}`]); const [rows] = await this.pool.query<any[]>('SELECT id,name,token_hint,enabled,last_seen_at,plugin_version,api_version FROM proxy_instances WHERE id=?', [input.id]); return rows[0] ? rowToProxy(rows[0]) : undefined; } catch (error) { if ((error as { code?: string }).code === 'ER_DUP_ENTRY') return undefined; throw error; } }
  async rotateProxyToken(id: string, token: string): Promise<ProxySummary | undefined> { const [result] = await this.pool.query<any>('UPDATE proxy_instances SET token_hash=?,token_hint=? WHERE id=?', [hashToken(token), `****${token.slice(-4)}`, id]); if (!result.affectedRows) return undefined; const [rows] = await this.pool.query<any[]>('SELECT id,name,token_hint,enabled,last_seen_at,plugin_version,api_version FROM proxy_instances WHERE id=?', [id]); return rows[0] ? rowToProxy(rows[0]) : undefined; }
  async listTargets(): Promise<Target[]> { const [rows] = await this.pool.query<any[]>("SELECT t.*, (SELECT started_at FROM lifecycle_operations lo WHERE lo.target_id=t.id AND lo.operation IN ('start','restart') AND lo.outcome IN ('accepted','transitioned') ORDER BY lo.started_at DESC LIMIT 1) AS startup_started_at, EXISTS(SELECT 1 FROM lifecycle_operations restart_op WHERE restart_op.target_id=t.id AND restart_op.operation='restart' AND restart_op.outcome='accepted') AS restart_pending FROM target_servers t WHERE t.enabled=1 ORDER BY t.display_name"); return rows.map(rowToTarget); }
  async createTarget(input: TargetInput): Promise<Target | undefined> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query('INSERT INTO target_servers (id,slug,display_name,aliases,panel_server_identifier,backend_host,backend_port,software,loader,minecraft_version,entry_profile,startup_timeout_seconds,idle_timeout_seconds) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', [input.id, input.slug, input.displayName, JSON.stringify(input.aliases), input.panelServerIdentifier ?? null, input.backendHost ?? null, input.backendPort ?? null, input.software ?? null, input.loader ?? null, input.minecraftVersion ?? null, input.entryProfile ?? null, input.startupTimeoutSeconds ?? 300, input.idleTimeoutSeconds ?? 900]);
      for (const alias of input.aliases) await connection.query('INSERT INTO domain_routes (id,normalized_hostname,target_id,route_enabled) VALUES (UUID(),?,?,1)', [normalizeHostname(alias), input.id]);
      await connection.commit();
      return this.getTarget(input.id);
    } catch (error) {
      await connection.rollback();
      if ((error as { code?: string }).code === 'ER_DUP_ENTRY') return undefined;
      throw error;
    } finally {
      connection.release();
    }
  }
  async updateTarget(id: string, input: TargetInput): Promise<Target | undefined> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query<any[]>('SELECT id FROM target_servers WHERE id=? FOR UPDATE', [id]);
      if (!rows[0]) { await connection.rollback(); return undefined; }
      await connection.query('UPDATE target_servers SET slug=?,display_name=?,aliases=?,panel_server_identifier=?,backend_host=?,backend_port=?,software=?,loader=?,minecraft_version=?,entry_profile=?,startup_timeout_seconds=?,idle_timeout_seconds=?,updated_at=UTC_TIMESTAMP(3) WHERE id=?', [input.slug, input.displayName, JSON.stringify(input.aliases), input.panelServerIdentifier ?? null, input.backendHost ?? null, input.backendPort ?? null, input.software ?? null, input.loader ?? null, input.minecraftVersion ?? null, input.entryProfile ?? null, input.startupTimeoutSeconds ?? 300, input.idleTimeoutSeconds ?? 900, id]);
      await connection.query('DELETE FROM domain_routes WHERE target_id=?', [id]);
      for (const alias of input.aliases) await connection.query('INSERT INTO domain_routes (id,normalized_hostname,target_id,route_enabled) VALUES (UUID(),?,?,1)', [normalizeHostname(alias), id]);
      await connection.commit();
      return this.getTarget(id);
    } catch (error) {
      await connection.rollback();
      if ((error as { code?: string }).code === 'ER_DUP_ENTRY') return undefined;
      throw error;
    } finally {
      connection.release();
    }
  }
  async deleteTarget(id: string): Promise<boolean> { const [result] = await this.pool.query<any>('DELETE FROM target_servers WHERE id=?', [id]); return result.affectedRows > 0; }
  async beginPowerOperation(targetId: string, signal: 'start' | 'stop' | 'restart'): Promise<string> { const id = randomUUID(); await this.pool.query('INSERT INTO lifecycle_operations (id,target_id,operation,idempotency_key,outcome,started_at) VALUES (?,?,?,?,?,UTC_TIMESTAMP(3))', [id, targetId, signal, `admin:${id}`, 'accepted']); return id; }
  async failPowerOperation(operationId: string, error: string): Promise<void> { await this.pool.query("UPDATE lifecycle_operations SET outcome='failed',error=?,finished_at=UTC_TIMESTAMP(3) WHERE id=?", [error, operationId]); }
  async getTarget(id: string): Promise<Target | undefined> { const [rows] = await this.pool.query<any[]>("SELECT t.*, (SELECT started_at FROM lifecycle_operations lo WHERE lo.target_id=t.id AND lo.operation IN ('start','restart') AND lo.outcome IN ('accepted','transitioned') ORDER BY lo.started_at DESC LIMIT 1) AS startup_started_at, EXISTS(SELECT 1 FROM lifecycle_operations restart_op WHERE restart_op.target_id=t.id AND restart_op.operation='restart' AND restart_op.outcome='accepted') AS restart_pending FROM target_servers t WHERE t.id=?", [id]); return rows[0] ? rowToTarget(rows[0]) : undefined; }
  async findTargetByHostname(hostname: string): Promise<Target | undefined> { const [rows] = await this.pool.query<any[]>('SELECT t.* FROM target_servers t JOIN domain_routes d ON d.target_id=t.id WHERE d.normalized_hostname=? AND d.route_enabled=1 LIMIT 1', [normalizeHostname(hostname)]); return rows[0] ? rowToTarget(rows[0]) : undefined; }
  async wakeTarget(id: string, idempotencyKey: string): Promise<WakeResult> {
    const connection = await this.pool.getConnection();
    try { await connection.beginTransaction(); const [rows] = await connection.query<any[]>('SELECT * FROM target_servers WHERE id=? FOR UPDATE', [id]); if (!rows[0]) { await connection.rollback(); return { accepted: false, reason: 'TARGET_NOT_FOUND', target: undefined as never }; } const target = rowToTarget(rows[0]); if (['READY', 'IDLE_COUNTDOWN'].includes(target.lifecycle)) { await connection.commit(); return { accepted: true, target, shouldPower: false }; } const [ops] = await connection.query<any[]>('SELECT id FROM lifecycle_operations WHERE target_id=? AND idempotency_key=? LIMIT 1', [id, idempotencyKey]); if (ops[0]) { await connection.commit(); return { accepted: true, target, shouldPower: false, operationId: ops[0].id }; } if (['STARTING', 'START_REQUESTED', 'RUNNING_UNREADY'].includes(target.lifecycle)) { const [latest] = await connection.query<any[]>('SELECT id FROM lifecycle_operations WHERE target_id=? AND operation IN (\'start\',\'restart\') AND outcome=\'accepted\' ORDER BY started_at DESC LIMIT 1', [id]); await connection.commit(); return { accepted: true, target, shouldPower: false, operationId: latest[0]?.id }; } if (['STOP_REQUESTED', 'STOPPING', 'SUSPENDED', 'BLOCKED', 'API_ERROR'].includes(target.lifecycle)) { await connection.commit(); return { accepted: false, target, shouldPower: false, reason: target.lifecycle }; } const operationId = randomUUID(); await connection.query('INSERT INTO lifecycle_operations (id,target_id,operation,idempotency_key,outcome,started_at) VALUES (?,?,?,?,?,UTC_TIMESTAMP(3))', [operationId, id, 'start', idempotencyKey, 'accepted']); await connection.query("UPDATE target_servers SET normalized_state='START_REQUESTED', readiness=0, last_error=NULL, updated_at=UTC_TIMESTAMP(3) WHERE id=?", [id]); await connection.commit(); target.lifecycle = 'START_REQUESTED'; target.ready = false; target.lastError = undefined; return { accepted: true, target, shouldPower: true, operationId }; } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }
  async updateTargetLifecycle(id: string, rawState: string, ready: boolean, error?: string, options?: { suspended?: boolean; blockedReason?: string; idle?: boolean }): Promise<Target | undefined> {
    const [currentRows] = await this.pool.query<any[]>('SELECT raw_state FROM target_servers WHERE id=?', [id]);
    const wasRunning = currentRows[0]?.raw_state === 'running';
    const lifecycle = normalizeLifecycle({ rawState, ready, failed: Boolean(error), suspended: options?.suspended, blockedReason: options?.blockedReason, idle: options?.idle });
    if (['start_requested', 'stop_requested', 'api_error'].includes(rawState)) {
      await this.pool.query('UPDATE target_servers SET updated_at=IF(normalized_state=? AND readiness=0 AND ((last_error IS NULL AND ? IS NULL) OR last_error=?),updated_at,UTC_TIMESTAMP(3)),normalized_state=?,readiness=0,last_error=?,zero_since=NULL WHERE id=?', [lifecycle, error ?? null, error ?? null, lifecycle, error ?? null, id]);
    } else {
      await this.pool.query('UPDATE target_servers SET updated_at=IF(raw_state=? AND normalized_state=? AND readiness=? AND ((last_error IS NULL AND ? IS NULL) OR last_error=?),updated_at,UTC_TIMESTAMP(3)),zero_since=IF(?=0 OR ?<>\'running\' OR ?=0,NULL,zero_since),raw_state=?,normalized_state=?,readiness=?,last_error=? WHERE id=?', [rawState, lifecycle, ready ? 1 : 0, error ?? null, error ?? null, wasRunning ? 1 : 0, rawState, ready ? 1 : 0, rawState, lifecycle, ready ? 1 : 0, error ?? null, id]);
      if (rawState !== 'running') await this.pool.query("UPDATE lifecycle_operations SET outcome='transitioned' WHERE target_id=? AND operation='restart' AND outcome='accepted'", [id]);
    }
    if (['READY', 'IDLE_COUNTDOWN', 'FAILED', 'OFFLINE'].includes(lifecycle)) {
      await this.pool.query("UPDATE lifecycle_operations SET outcome=?,finished_at=UTC_TIMESTAMP(3),error=COALESCE(?,error) WHERE target_id=? AND operation IN ('start','restart') AND outcome IN ('accepted','transitioned')", [lifecycle.toLowerCase(), error ?? null, id]);
    }
    if (['STOPPING', 'OFFLINE'].includes(lifecycle)) {
      await this.pool.query("UPDATE lifecycle_operations SET outcome=?,finished_at=UTC_TIMESTAMP(3),error=COALESCE(?,error) WHERE target_id=? AND operation='stop' AND outcome='accepted'", [lifecycle.toLowerCase(), error ?? null, id]);
    }
    if (['READY', 'IDLE_COUNTDOWN', 'FAILED', 'OFFLINE'].includes(lifecycle)) {
      await this.pool.query("UPDATE lifecycle_operations SET outcome=?,finished_at=UTC_TIMESTAMP(3),error=COALESCE(?,error) WHERE target_id=? AND operation='restart' AND outcome='accepted'", [lifecycle.toLowerCase(), error ?? null, id]);
    }
    return this.getTarget(id);
  }
  async saveHeartbeat(proxyId: string, targetId: string, count: number, observedAt: string, quality = 'fresh', freshnessSeconds = 45): Promise<void> { await this.pool.query('INSERT INTO presence_snapshots (id,proxy_id,target_id,observed_at,player_count,quality) VALUES (UUID(),?,?,?,?,?)', [proxyId, targetId, new Date(observedAt), count, quality]); if (quality !== 'fresh') return; const [rows] = await this.pool.query<any[]>('SELECT heartbeat_at,zero_since,raw_state,readiness FROM target_servers WHERE id=?', [targetId]); if (!rows[0]) return; const previous = rows[0].heartbeat_at?.getTime?.() ?? Date.parse(rows[0].heartbeat_at ?? ''); const observed = new Date(observedAt).getTime(); if (Number.isFinite(previous) && (!Number.isFinite(observed) || observed <= previous)) return; const ready = rows[0].raw_state === 'running' && Boolean(rows[0].readiness); const stale = !Number.isFinite(previous) || observed - previous > freshnessSeconds * 1000; const zeroSince = count === 0 && ready ? (stale ? new Date(observedAt) : rows[0].zero_since ?? new Date(observedAt)) : null; await this.pool.query('UPDATE target_servers SET player_count=?, heartbeat_at=?, zero_since=? WHERE id=?', [count, new Date(observedAt), zeroSince, targetId]); }
  async upsertTicket(input: { targetId: string; playerUuid: string; playerName?: string; ticketClass: TicketClass; snapshot?: string; ttlSeconds?: number }): Promise<QueueTicket> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query('SELECT id FROM target_servers WHERE id=? FOR UPDATE', [input.targetId]);
      const [existing] = await connection.query<any[]>('SELECT * FROM queue_tickets WHERE target_id=? AND player_uuid=? AND state IN (\'waiting\',\'promoted\') AND expires_at>UTC_TIMESTAMP(3) LIMIT 1 FOR UPDATE', [input.targetId, input.playerUuid]);
      const state = input.ticketClass === 'online' ? 'promoted' : 'waiting';
      const activeKey = `${input.targetId}:${input.playerUuid}`;
      if (existing[0]) {
        const row = existing[0];
        const expiresAt = ticketExpiresAt(input.ttlSeconds);
        await connection.query('UPDATE queue_tickets SET ticket_class=?,state=?,active_player_key=?,last_player_name=?,updated_at=UTC_TIMESTAMP(3),expires_at=?,last_status_snapshot=COALESCE(?,last_status_snapshot) WHERE id=?', [input.ticketClass, state, activeKey, input.playerName ?? row.last_player_name, expiresAt, input.snapshot ?? null, row.id]);
        await connection.query('INSERT INTO queue_events (id,ticket_id,event_type,source,payload) VALUES (UUID(),?,?,?,?)', [row.id, input.ticketClass === 'online' ? 'promoted' : 'refreshed', 'proxy', JSON.stringify({ snapshot: input.snapshot ?? null })]);
        await connection.commit();
        return rowToTicket({ ...row, ticket_class: input.ticketClass, state, active_player_key: activeKey, last_player_name: input.playerName ?? row.last_player_name, expires_at: expiresAt, last_status_snapshot: input.snapshot ?? row.last_status_snapshot });
      }
      const id = randomUUID();
      await connection.query("UPDATE queue_tickets SET state='expired',active_player_key=NULL,updated_at=UTC_TIMESTAMP(3) WHERE target_id=? AND player_uuid=? AND state IN ('waiting','promoted') AND expires_at<=UTC_TIMESTAMP(3)", [input.targetId, input.playerUuid]);
      const expiresAt = ticketExpiresAt(input.ttlSeconds);
      await connection.query('INSERT INTO queue_tickets (id,target_id,player_uuid,last_player_name,ticket_class,state,active_player_key,enqueue_sequence,created_at,updated_at,expires_at,last_status_snapshot) SELECT ?,?,?,?,?,?,?,COALESCE(MAX(enqueue_sequence),0)+1,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3),?,? FROM queue_tickets WHERE target_id=?', [id, input.targetId, input.playerUuid, input.playerName ?? null, input.ticketClass, state, activeKey, expiresAt, input.snapshot ?? null, input.targetId]);
      await connection.query('INSERT INTO queue_events (id,ticket_id,event_type,source,payload) VALUES (UUID(),?,?,?,?)', [id, 'created', 'proxy', JSON.stringify({ ticketClass: input.ticketClass, snapshot: input.snapshot ?? null })]);
      const [rows] = await connection.query<any[]>('SELECT * FROM queue_tickets WHERE id=?', [id]);
      await connection.commit();
      return rowToTicket(rows[0]);
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
  async findActiveTicket(targetId: string, playerUuid: string): Promise<QueueTicket | undefined> { const [rows] = await this.pool.query<any[]>('SELECT * FROM queue_tickets WHERE target_id=? AND player_uuid=? AND state IN (\'waiting\',\'promoted\') AND expires_at>UTC_TIMESTAMP(3) ORDER BY updated_at DESC LIMIT 1', [targetId, playerUuid]); return rows[0] ? rowToTicket(rows[0]) : undefined; }
  async updateTicketEvent(targetId: string, ticketId: string, event: string, snapshot?: string): Promise<QueueTicket | undefined> {
    const state = ({ promoted: 'promoted', transferred: 'transferred', failed: 'failed', expired: 'expired' } as Record<string, string>)[event];
    if (!state) return undefined;
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [currentRows] = await connection.query<any[]>('SELECT * FROM queue_tickets WHERE id=? AND target_id=? FOR UPDATE', [ticketId, targetId]);
      const current = currentRows[0];
      if (!current) { await connection.rollback(); return undefined; }
      if (current.state === state || !['waiting', 'promoted'].includes(current.state)) { await connection.commit(); return rowToTicket(current); }
      await connection.query('UPDATE queue_tickets SET state=?,active_player_key=CASE WHEN ? IN (\'transferred\',\'failed\',\'expired\') THEN NULL ELSE active_player_key END,updated_at=UTC_TIMESTAMP(3),last_status_snapshot=COALESCE(?,last_status_snapshot) WHERE id=? AND target_id=?', [state, state, snapshot ?? null, ticketId, targetId]);
      await connection.query('INSERT INTO queue_events (id,ticket_id,event_type,source,payload) VALUES (UUID(),?,?,?,?)', [ticketId, event, 'proxy', JSON.stringify({ snapshot: snapshot ?? null })]);
      const [rows] = await connection.query<any[]>('SELECT * FROM queue_tickets WHERE id=? AND target_id=?', [ticketId, targetId]);
      await connection.commit();
      return rows[0] ? rowToTicket(rows[0]) : undefined;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
  async listTickets(targetId: string): Promise<QueueTicket[]> { const [rows] = await this.pool.query<any[]>('SELECT * FROM queue_tickets WHERE target_id=? AND state IN (\'waiting\',\'promoted\') AND expires_at>UTC_TIMESTAMP(3) ORDER BY enqueue_sequence', [targetId]); return rows.map(rowToTicket); }
  async expireTickets(now = new Date()): Promise<number> { const [result] = await this.pool.query<any>("UPDATE queue_tickets SET state='expired',active_player_key=NULL,updated_at=UTC_TIMESTAMP(3) WHERE state IN ('waiting','promoted') AND expires_at<=?", [now]); return result.affectedRows ?? 0; }
}

function parseAliases(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string' || !value) return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.map(String) : []; } catch { return []; }
}
function rowToTarget(row: any): Target { return { id: String(row.id), slug: row.slug, displayName: row.display_name, aliases: parseAliases(row.aliases), rawState: row.raw_state ?? 'unknown', lifecycle: row.normalized_state ?? 'UNKNOWN', ready: Boolean(row.readiness), restartPending: Boolean(row.restart_pending), enabled: Boolean(row.enabled), playerCount: Number(row.player_count ?? 0), heartbeatAt: row.heartbeat_at?.toISOString?.() ?? row.heartbeat_at, zeroSince: row.zero_since?.toISOString?.() ?? row.zero_since, lastError: row.last_error ?? undefined, updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at, startupStartedAt: row.startup_started_at?.toISOString?.() ?? row.startup_started_at ?? undefined, startupTimeoutSeconds: Number(row.startup_timeout_seconds ?? 300), idleTimeoutSeconds: Number(row.idle_timeout_seconds ?? 900), panelServerIdentifier: row.panel_server_identifier ?? undefined, backendHost: row.backend_host ?? undefined, backendPort: row.backend_port ? Number(row.backend_port) : undefined, software: row.software ?? undefined, loader: row.loader ?? undefined, minecraftVersion: row.minecraft_version ?? undefined, entryProfile: row.entry_profile ?? undefined }; }
function rowToProxy(row: any): ProxySummary { return { id: String(row.id), name: row.name, tokenHint: row.token_hint ?? undefined, enabled: Boolean(row.enabled), lastSeenAt: row.last_seen_at?.toISOString?.() ?? row.last_seen_at ?? undefined, pluginVersion: row.plugin_version ?? undefined, apiVersion: row.api_version ?? undefined }; }
function rowToTicket(row: any): QueueTicket { return { id: row.id, targetId: row.target_id, playerUuid: row.player_uuid, playerName: row.last_player_name ?? undefined, ticketClass: row.ticket_class, state: row.state, sequence: Number(row.enqueue_sequence), createdAt: row.created_at?.toISOString?.() ?? row.created_at, updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at, expiresAt: row.expires_at?.toISOString?.() ?? row.expires_at, lastSnapshot: row.last_status_snapshot ?? undefined }; }

export function hashToken(token: string): string { return createHash('sha256').update(token).digest('hex'); }
