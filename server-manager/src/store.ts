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

export interface WakeResult {
  target: Target;
  operationId?: string;
  accepted: boolean;
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
  getTarget(id: string): Promise<Target | undefined>;
  findTargetByHostname(hostname: string): Promise<Target | undefined>;
  wakeTarget(id: string, idempotencyKey: string): Promise<WakeResult>;
  updateTargetLifecycle(id: string, rawState: string, ready: boolean, error?: string): Promise<Target | undefined>;
  saveHeartbeat(proxyId: string, targetId: string, count: number, observedAt: string, quality?: string): Promise<void>;
  upsertTicket(input: { targetId: string; playerUuid: string; playerName?: string; ticketClass: TicketClass; snapshot?: string }): Promise<QueueTicket>;
  updateTicketEvent(targetId: string, ticketId: string, event: string, snapshot?: string): Promise<QueueTicket | undefined>;
  listTickets(targetId: string): Promise<QueueTicket[]>;
  expireTickets(now?: Date): Promise<number>;
  authenticateProxy(token: string): Promise<string | undefined>;
  touchProxy(proxyId: string, observedAt: string): Promise<void>;
  listProxies(): Promise<ProxySummary[]>;
  createProxy(input: { id: string; name: string; token: string }): Promise<ProxySummary | undefined>;
  rotateProxyToken(id: string, token: string): Promise<ProxySummary | undefined>;
}

function normalizeHostname(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '');
}

function newTicket(input: { targetId: string; playerUuid: string; playerName?: string; ticketClass: TicketClass; sequence: number; snapshot?: string }): QueueTicket {
  const now = new Date();
  return { id: randomUUID(), targetId: input.targetId, playerUuid: input.playerUuid, playerName: input.playerName, ticketClass: input.ticketClass, state: input.ticketClass === 'online' ? 'promoted' : 'waiting', sequence: input.sequence, createdAt: now.toISOString(), updatedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(), lastSnapshot: input.snapshot };
}

export class MemoryStore implements Store {
  private readonly proxyTokens: Map<string, string>;
  private readonly targets = new Map<string, Target>();
  private readonly tickets = new Map<string, QueueTicket>();
  private readonly heartbeats = new Map<string, { count: number; observedAt: string }>();
  private sequence = 0;
  private readonly operations = new Map<string, { id: string; targetId: string; key: string }>();
  private readonly proxies = new Map<string, ProxySummary>();

  constructor(proxyTokens: Map<string, string>) {
    this.proxyTokens = proxyTokens;
    for (const [id, token] of proxyTokens) this.proxies.set(id, { id, name: id, tokenHint: `****${token.slice(-4)}`, enabled: true });
    this.targets.set('survival', { id: 'survival', slug: 'survival', displayName: '生存世界', aliases: ['survival.example.net', '生存.example.net'], rawState: 'offline', lifecycle: 'OFFLINE', ready: false, enabled: true, playerCount: 0, startupTimeoutSeconds: 300, idleTimeoutSeconds: 900, panelServerIdentifier: 'survival' , backendHost: '127.0.0.1', backendPort: 25565, software: 'Paper', loader: 'Paper', minecraftVersion: '1.21.1', entryProfile: 'default-lobby' });
    for (const [id] of proxyTokens) {
      void id;
    }
  }

  async close(): Promise<void> {}
  async authenticateProxy(token: string): Promise<string | undefined> { return [...this.proxyTokens.entries()].find(([, configured]) => configured === token)?.[0]; }
  async touchProxy(proxyId: string, observedAt: string): Promise<void> {
    const proxy = this.proxies.get(proxyId);
    if (proxy) this.proxies.set(proxyId, { ...proxy, lastSeenAt: observedAt });
  }
  async listProxies(): Promise<ProxySummary[]> { return [...this.proxies.values()]; }
  async createProxy(input: { id: string; name: string; token: string }): Promise<ProxySummary | undefined> { if (this.proxies.has(input.id)) return undefined; this.proxyTokens.set(input.id, input.token); const proxy = { id: input.id, name: input.name, tokenHint: `****${input.token.slice(-4)}`, enabled: true }; this.proxies.set(input.id, proxy); return proxy; }
  async rotateProxyToken(id: string, token: string): Promise<ProxySummary | undefined> { const proxy = this.proxies.get(id); if (!proxy) return undefined; this.proxyTokens.set(id, token); const updated = { ...proxy, tokenHint: `****${token.slice(-4)}` }; this.proxies.set(id, updated); return updated; }
  async listTargets(): Promise<Target[]> { return [...this.targets.values()]; }
  async getTarget(id: string): Promise<Target | undefined> { return this.targets.get(id); }
  async findTargetByHostname(hostname: string): Promise<Target | undefined> {
    const normalized = normalizeHostname(hostname);
    return [...this.targets.values()].find((target) => target.aliases.map(normalizeHostname).includes(normalized));
  }
  async wakeTarget(id: string, idempotencyKey: string): Promise<WakeResult> {
    const target = this.targets.get(id);
    if (!target) return { accepted: false, reason: 'TARGET_NOT_FOUND', target: undefined as never };
    if (target.lifecycle === 'READY' || target.lifecycle === 'IDLE_COUNTDOWN') return { accepted: true, target };
    if (target.lifecycle === 'STARTING' || target.lifecycle === 'START_REQUESTED' || target.lifecycle === 'RUNNING_UNREADY') return { accepted: true, target, operationId: [...this.operations.values()].find((x) => x.targetId === id)?.id };
    if (target.lifecycle === 'STOPPING' || target.lifecycle === 'SUSPENDED' || target.lifecycle === 'BLOCKED' || target.lifecycle === 'API_ERROR') return { accepted: false, target, reason: target.lifecycle };
    const existing = this.operations.get(`${id}:${idempotencyKey}`);
    if (existing) return { accepted: true, target: this.targets.get(id)!, operationId: existing.id };
    target.rawState = 'starting'; target.lifecycle = 'START_REQUESTED'; target.lastError = undefined;
    const operationId = randomUUID();
    this.operations.set(`${id}:${idempotencyKey}`, { id: operationId, targetId: id, key: idempotencyKey });
    return { accepted: true, target, operationId };
  }
  async updateTargetLifecycle(id: string, rawState: string, ready: boolean, error?: string): Promise<Target | undefined> {
    const target = this.targets.get(id); if (!target) return undefined;
    target.rawState = rawState; target.ready = ready; target.lastError = error;
    target.lifecycle = normalizeLifecycle({ rawState, ready, failed: Boolean(error) });
    return target;
  }
  async saveHeartbeat(_proxyId: string, targetId: string, count: number, observedAt: string): Promise<void> {
    this.heartbeats.set(targetId, { count, observedAt });
    const target = this.targets.get(targetId); if (!target) return;
    target.playerCount = count; target.heartbeatAt = observedAt;
    if (count === 0 && target.zeroSince === undefined) target.zeroSince = observedAt;
    if (count > 0) target.zeroSince = undefined;
  }
  async upsertTicket(input: { targetId: string; playerUuid: string; playerName?: string; ticketClass: TicketClass; snapshot?: string }): Promise<QueueTicket> {
    const existing = [...this.tickets.values()].find((ticket) => ticket.targetId === input.targetId && ticket.playerUuid === input.playerUuid && !['transferred', 'expired'].includes(ticket.state));
    if (existing) { existing.ticketClass = input.ticketClass; existing.state = input.ticketClass === 'online' ? 'promoted' : existing.state; existing.playerName = input.playerName ?? existing.playerName; existing.updatedAt = new Date().toISOString(); existing.lastSnapshot = input.snapshot; return existing; }
    const ticket = newTicket({ ...input, sequence: ++this.sequence }); this.tickets.set(ticket.id, ticket); return ticket;
  }
  async updateTicketEvent(targetId: string, ticketId: string, event: string, snapshot?: string): Promise<QueueTicket | undefined> {
    const ticket = this.tickets.get(ticketId); if (!ticket || ticket.targetId !== targetId) return undefined;
    const state: TicketState | undefined = ({ promoted: 'promoted', transferred: 'transferred', failed: 'failed', expired: 'expired' } as Record<string, TicketState>)[event];
    if (state) ticket.state = state; ticket.updatedAt = new Date().toISOString(); ticket.lastSnapshot = snapshot ?? ticket.lastSnapshot; return ticket;
  }
  async listTickets(targetId: string): Promise<QueueTicket[]> { return [...this.tickets.values()].filter((ticket) => ticket.targetId === targetId && ['waiting', 'promoted'].includes(ticket.state) && new Date(ticket.expiresAt).getTime() > Date.now()).sort((a, b) => a.sequence - b.sequence); }
  async expireTickets(now = new Date()): Promise<number> { let count = 0; for (const ticket of this.tickets.values()) if (['waiting', 'promoted'].includes(ticket.state) && new Date(ticket.expiresAt) <= now) { ticket.state = 'expired'; ticket.updatedAt = now.toISOString(); count++; } return count; }
}

export class MysqlStore implements Store {
  private constructor(private readonly pool: Pool) {}
  static async connect(url: string): Promise<MysqlStore> { const pool = mysql.createPool(url); await pool.query('SELECT 1'); return new MysqlStore(pool); }
  async close(): Promise<void> { await this.pool.end(); }
  async authenticateProxy(token: string): Promise<string | undefined> { const [rows] = await this.pool.query<any[]>('SELECT id FROM proxy_instances WHERE token_hash=? AND enabled=1 LIMIT 1', [hashToken(token)]); return rows[0]?.id; }
  async touchProxy(proxyId: string, observedAt: string): Promise<void> { await this.pool.query('UPDATE proxy_instances SET last_seen_at=? WHERE id=? AND enabled=1', [new Date(observedAt), proxyId]); }
  async listProxies(): Promise<ProxySummary[]> { const [rows] = await this.pool.query<any[]>('SELECT id,name,token_hint,enabled,last_seen_at,plugin_version,api_version FROM proxy_instances ORDER BY name'); return rows.map(rowToProxy); }
  async createProxy(input: { id: string; name: string; token: string }): Promise<ProxySummary | undefined> { try { await this.pool.query('INSERT INTO proxy_instances (id,name,token_hash,token_hint,enabled) VALUES (?,?,?,?,1)', [input.id, input.name, hashToken(input.token), `****${input.token.slice(-4)}`]); const [rows] = await this.pool.query<any[]>('SELECT id,name,token_hint,enabled,last_seen_at,plugin_version,api_version FROM proxy_instances WHERE id=?', [input.id]); return rows[0] ? rowToProxy(rows[0]) : undefined; } catch (error) { if ((error as { code?: string }).code === 'ER_DUP_ENTRY') return undefined; throw error; } }
  async rotateProxyToken(id: string, token: string): Promise<ProxySummary | undefined> { const [result] = await this.pool.query<any>('UPDATE proxy_instances SET token_hash=?,token_hint=? WHERE id=?', [hashToken(token), `****${token.slice(-4)}`, id]); if (!result.affectedRows) return undefined; const [rows] = await this.pool.query<any[]>('SELECT id,name,token_hint,enabled,last_seen_at,plugin_version,api_version FROM proxy_instances WHERE id=?', [id]); return rows[0] ? rowToProxy(rows[0]) : undefined; }
  async listTargets(): Promise<Target[]> { const [rows] = await this.pool.query<any[]>('SELECT * FROM target_servers WHERE enabled = 1 ORDER BY display_name'); return rows.map(rowToTarget); }
  async getTarget(id: string): Promise<Target | undefined> { const [rows] = await this.pool.query<any[]>('SELECT * FROM target_servers WHERE id = ?', [id]); return rows[0] ? rowToTarget(rows[0]) : undefined; }
  async findTargetByHostname(hostname: string): Promise<Target | undefined> { const [rows] = await this.pool.query<any[]>('SELECT t.* FROM target_servers t JOIN domain_routes d ON d.target_id=t.id WHERE d.normalized_hostname=? AND d.route_enabled=1 LIMIT 1', [normalizeHostname(hostname)]); return rows[0] ? rowToTarget(rows[0]) : undefined; }
  async wakeTarget(id: string, idempotencyKey: string): Promise<WakeResult> {
    const connection = await this.pool.getConnection();
    try { await connection.beginTransaction(); const [rows] = await connection.query<any[]>('SELECT * FROM target_servers WHERE id=? FOR UPDATE', [id]); if (!rows[0]) return { accepted: false, reason: 'TARGET_NOT_FOUND', target: undefined as never }; const target = rowToTarget(rows[0]); if (['READY', 'IDLE_COUNTDOWN'].includes(target.lifecycle)) { await connection.commit(); return { accepted: true, target }; } const [ops] = await connection.query<any[]>('SELECT id FROM lifecycle_operations WHERE target_id=? AND idempotency_key=? LIMIT 1', [id, idempotencyKey]); if (ops[0]) { await connection.commit(); return { accepted: true, target, operationId: ops[0].id }; } if (['STARTING', 'START_REQUESTED', 'RUNNING_UNREADY'].includes(target.lifecycle)) { await connection.commit(); return { accepted: true, target }; } if (['STOPPING', 'SUSPENDED', 'BLOCKED', 'API_ERROR'].includes(target.lifecycle)) { await connection.commit(); return { accepted: false, target, reason: target.lifecycle }; } const operationId = randomUUID(); await connection.query('INSERT INTO lifecycle_operations (id,target_id,operation,idempotency_key,outcome,started_at) VALUES (?,?,?,?,?,UTC_TIMESTAMP(3))', [operationId, id, 'start', idempotencyKey, 'accepted']); await connection.query("UPDATE target_servers SET raw_state='starting', normalized_state='START_REQUESTED', updated_at=UTC_TIMESTAMP(3) WHERE id=?", [id]); await connection.commit(); target.rawState = 'starting'; target.lifecycle = 'START_REQUESTED'; return { accepted: true, target, operationId }; } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }
  async updateTargetLifecycle(id: string, rawState: string, ready: boolean, error?: string): Promise<Target | undefined> { const lifecycle = normalizeLifecycle({ rawState, ready, failed: Boolean(error) }); await this.pool.query('UPDATE target_servers SET raw_state=?, normalized_state=?, readiness=?, last_error=?, updated_at=UTC_TIMESTAMP(3) WHERE id=?', [rawState, lifecycle, ready ? 1 : 0, error ?? null, id]); return this.getTarget(id); }
  async saveHeartbeat(proxyId: string, targetId: string, count: number, observedAt: string, quality = 'fresh'): Promise<void> { await this.pool.query('INSERT INTO presence_snapshots (id,proxy_id,target_id,observed_at,player_count,quality) VALUES (UUID(),?,?,?,?,?)', [proxyId, targetId, new Date(observedAt), count, quality]); await this.pool.query('UPDATE target_servers SET player_count=?, heartbeat_at=?, zero_since=IF(?=0,COALESCE(zero_since,?),NULL), updated_at=UTC_TIMESTAMP(3) WHERE id=?', [count, new Date(observedAt), count, new Date(observedAt), targetId]); }
  async upsertTicket(input: { targetId: string; playerUuid: string; playerName?: string; ticketClass: TicketClass; snapshot?: string }): Promise<QueueTicket> { const existing = await this.pool.query<any[]>('SELECT * FROM queue_tickets WHERE target_id=? AND player_uuid=? AND state IN (\'waiting\',\'promoted\') LIMIT 1', [input.targetId, input.playerUuid]); if (existing[0][0]) { const row = existing[0][0]; await this.pool.query('UPDATE queue_tickets SET ticket_class=?,last_player_name=?,updated_at=UTC_TIMESTAMP(3),last_status_snapshot=? WHERE id=?', [input.ticketClass, input.playerName ?? row.last_player_name, input.snapshot ?? null, row.id]); return rowToTicket({ ...row, ticket_class: input.ticketClass, last_player_name: input.playerName ?? row.last_player_name }); } const id = randomUUID(); const state = input.ticketClass === 'online' ? 'promoted' : 'waiting'; const activeKey = `${input.targetId}:${input.playerUuid}`; await this.pool.query('INSERT INTO queue_tickets (id,target_id,player_uuid,last_player_name,ticket_class,state,active_player_key,enqueue_sequence,created_at,updated_at,expires_at,last_status_snapshot) SELECT ?,?,?,?,?,?,?,COALESCE(MAX(enqueue_sequence),0)+1,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3),DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 30 MINUTE),? FROM queue_tickets WHERE target_id=?', [id, input.targetId, input.playerUuid, input.playerName ?? null, input.ticketClass, state, activeKey, input.snapshot ?? null, input.targetId]); const [rows] = await this.pool.query<any[]>('SELECT * FROM queue_tickets WHERE id=?', [id]); return rowToTicket(rows[0]); }
  async updateTicketEvent(targetId: string, ticketId: string, event: string, snapshot?: string): Promise<QueueTicket | undefined> { const state = ({ promoted: 'promoted', transferred: 'transferred', failed: 'failed', expired: 'expired' } as Record<string, string>)[event]; if (!state) return undefined; await this.pool.query('UPDATE queue_tickets SET state=?,active_player_key=CASE WHEN ? IN (\'transferred\',\'failed\',\'expired\') THEN NULL ELSE active_player_key END,updated_at=UTC_TIMESTAMP(3),last_status_snapshot=? WHERE id=? AND target_id=?', [state, state, snapshot ?? null, ticketId, targetId]); const [rows] = await this.pool.query<any[]>('SELECT * FROM queue_tickets WHERE id=? AND target_id=?', [ticketId, targetId]); return rows[0] ? rowToTicket(rows[0]) : undefined; }
  async listTickets(targetId: string): Promise<QueueTicket[]> { const [rows] = await this.pool.query<any[]>('SELECT * FROM queue_tickets WHERE target_id=? AND state IN (\'waiting\',\'promoted\') ORDER BY enqueue_sequence', [targetId]); return rows.map(rowToTicket); }
  async expireTickets(now = new Date()): Promise<number> { const [result] = await this.pool.query<any>("UPDATE queue_tickets SET state='expired',updated_at=UTC_TIMESTAMP(3) WHERE state IN ('waiting','promoted') AND expires_at<=?", [now]); return result.affectedRows ?? 0; }
}

function rowToTarget(row: any): Target { return { id: String(row.id), slug: row.slug, displayName: row.display_name, aliases: row.aliases ? JSON.parse(row.aliases) : [], rawState: row.raw_state ?? 'unknown', lifecycle: row.normalized_state ?? 'UNKNOWN', ready: Boolean(row.readiness), enabled: Boolean(row.enabled), playerCount: Number(row.player_count ?? 0), heartbeatAt: row.heartbeat_at?.toISOString?.() ?? row.heartbeat_at, zeroSince: row.zero_since?.toISOString?.() ?? row.zero_since, lastError: row.last_error ?? undefined, startupTimeoutSeconds: Number(row.startup_timeout_seconds ?? 300), idleTimeoutSeconds: Number(row.idle_timeout_seconds ?? 900), panelServerIdentifier: row.panel_server_identifier ?? undefined, backendHost: row.backend_host ?? undefined, backendPort: row.backend_port ? Number(row.backend_port) : undefined, software: row.software ?? undefined, loader: row.loader ?? undefined, minecraftVersion: row.minecraft_version ?? undefined, entryProfile: row.entry_profile ?? undefined }; }
function rowToProxy(row: any): ProxySummary { return { id: String(row.id), name: row.name, tokenHint: row.token_hint ?? undefined, enabled: Boolean(row.enabled), lastSeenAt: row.last_seen_at?.toISOString?.() ?? row.last_seen_at ?? undefined, pluginVersion: row.plugin_version ?? undefined, apiVersion: row.api_version ?? undefined }; }
function rowToTicket(row: any): QueueTicket { return { id: row.id, targetId: row.target_id, playerUuid: row.player_uuid, playerName: row.last_player_name ?? undefined, ticketClass: row.ticket_class, state: row.state, sequence: Number(row.enqueue_sequence), createdAt: row.created_at?.toISOString?.() ?? row.created_at, updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at, expiresAt: row.expires_at?.toISOString?.() ?? row.expires_at, lastSnapshot: row.last_status_snapshot ?? undefined }; }

export function hashToken(token: string): string { return createHash('sha256').update(token).digest('hex'); }
