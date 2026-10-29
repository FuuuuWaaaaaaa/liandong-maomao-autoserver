import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { summarizeTickets } from './domain/queue.js';
import { MemoryStore, MysqlStore, type Store } from './store.js';
import { PterodactylClient } from './pterodactyl.js';
import { LifecycleRuntime } from './lifecycle-runtime.js';

const config = loadConfig();
const store: Store = config.sqlType === 'mysql' ? await MysqlStore.connect(config.sqlAddress!) : new MemoryStore(config.proxyTokens);
const pterodactyl = new PterodactylClient(config.pterodactylUrl, config.pterodactylToken, config.pterodactylTimeoutMs);
const app = Fastify({ logger: true });
await app.register(cors, { origin: true });
const webRoot = join(process.cwd(), 'web', 'dist');
if (existsSync(webRoot)) await app.register(fastifyStatic, { root: webRoot, prefix: '/' });
const lifecycle = new LifecycleRuntime(store, pterodactyl, { pollSeconds: config.lifecyclePollSeconds, heartbeatFreshnessSeconds: config.heartbeatFreshnessSeconds, readinessProbeTimeoutMs: config.readinessProbeTimeoutMs, autoStopEnabled: config.autoStopEnabled }, (message, error) => app.log.warn({ error }, message));

function bearer(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization?.trim();
  if (!header) return undefined;
  const separator = header.indexOf(' ');
  if (separator < 0 || header.slice(0, separator).toLowerCase() !== 'bearer') return undefined;
  return header.slice(separator + 1).trim() || undefined;
}
async function requireProxy(request: FastifyRequest, reply: FastifyReply): Promise<string | undefined> { const token = bearer(request); if (!token) { void reply.code(401).send({ code: 'UNAUTHORIZED', message: '需要代理凭证' }); return undefined; } const configured = [...config.proxyTokens.entries()].find(([, value]) => value === token); const proxyId = configured?.[0] ?? await store.authenticateProxy(token); if (!proxyId) { void reply.code(401).send({ code: 'UNAUTHORIZED', message: '代理凭证无效' }); return undefined; } return proxyId; }
function requireAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  if (!config.adminApiToken) {
    void reply.code(503).send({ code: 'ADMIN_AUTH_NOT_CONFIGURED', message: '管理器未配置 ADMIN_API_TOKEN，请设置后重启服务' });
    return false;
  }
  if (bearer(request) !== config.adminApiToken) {
    void reply.code(401).send({ code: 'ADMIN_TOKEN_INVALID', message: '管理员令牌无效，请确认 ADMIN_API_TOKEN 并重启管理器' });
    return false;
  }
  return true;
}
function normalizeHostname(value: string): string { return value.trim().toLowerCase().replace(/\.$/, ''); }

app.get('/health/live', async () => ({ status: 'ok', service: 'liandong-maomao-server-manager' }));
app.get('/health/ready', async (_request, reply) => { try { await store.listTargets(); return { status: 'ready', sqlType: config.sqlType }; } catch { return reply.code(503).send({ status: 'not_ready' }); } });

app.get('/api/v1/proxy/config', async (request, reply) => { const proxyId = await requireProxy(request, reply); if (!proxyId) return; const targets = await store.listTargets(); const body = { apiVersion: 'v1', proxyId, queue: { transferNoticeSeconds: 5, transferStabilitySeconds: 2, heartbeatSeconds: 15 }, targets: targets.filter((target) => target.enabled).map((target) => ({ id: target.id, displayName: target.displayName, aliases: target.aliases, entryProfile: target.entryProfile, lifecycle: target.lifecycle, rawState: target.rawState, ready: target.ready })) }; const etag = `"${createHash('sha256').update(JSON.stringify(body)).digest('hex')}"`; reply.header('ETag', etag); if (request.headers['if-none-match'] === etag) return reply.code(304).send(); return body; });

const heartbeatSchema = z.object({ observedAt: z.string().datetime(), pluginVersion: z.string().max(64).optional(), apiVersion: z.string().max(16).optional(), targets: z.array(z.object({ targetId: z.string().min(1), playerCount: z.number().int().min(0).max(100000), quality: z.enum(['fresh', 'unknown']).default('fresh') })) });
app.post('/api/v1/proxy/heartbeat', async (request, reply) => { const proxyId = await requireProxy(request, reply); if (!proxyId) return; const parsed = heartbeatSchema.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ code: 'INVALID_BODY', message: '心跳格式无效', details: parsed.error.flatten() }); const observed = Date.parse(parsed.data.observedAt); if (observed > Date.now() + 60_000 || Date.now() - observed > config.heartbeatFreshnessSeconds * 1000) return reply.code(400).send({ code: 'STALE_OBSERVATION', message: '观测时间不在允许范围内' }); await store.touchProxy(proxyId, parsed.data.observedAt, parsed.data.pluginVersion, parsed.data.apiVersion); await Promise.all(parsed.data.targets.map((item) => store.saveHeartbeat(proxyId, item.targetId, item.playerCount, parsed.data.observedAt, item.quality, config.heartbeatFreshnessSeconds))); return { accepted: true, proxyId, observedAt: parsed.data.observedAt }; });

app.post('/api/v1/proxy/targets/:targetId/wake', async (request, reply) => { const proxyId = await requireProxy(request, reply); if (!proxyId) return; const targetId = (request.params as { targetId: string }).targetId; const key = request.headers['idempotency-key']?.toString() ?? `${proxyId}:${targetId}`; const result = await store.wakeTarget(targetId, key); if (!result.target) return reply.code(404).send({ code: result.reason ?? 'TARGET_NOT_FOUND', message: '目标服务器不存在' }); if (result.shouldPower) { if (!result.target.panelServerIdentifier || !config.pterodactylUrl || !config.pterodactylToken) { const message = 'Pterodactyl 未配置或目标缺少面板 identifier'; await store.failPowerOperation(result.operationId!, message); await store.updateTargetLifecycle(targetId, 'api_error', false, message); return reply.code(503).send({ code: 'PTERODACTYL_NOT_CONFIGURED', message: '未配置目标的 Pterodactyl 连接' }); } try { await pterodactyl.power(result.target.panelServerIdentifier, 'start'); } catch (error) { const message = error instanceof Error ? error.message : 'Pterodactyl 请求失败'; await store.failPowerOperation(result.operationId!, message); await store.updateTargetLifecycle(targetId, 'api_error', false, message); return reply.code(502).send({ code: 'PTERODACTYL_ERROR', message: '唤醒请求未被面板接受' }); } } return { accepted: result.accepted, operationId: result.operationId, lifecycle: result.target.lifecycle, rawState: result.target.rawState, reason: result.reason }; });

app.get('/api/v1/proxy/targets/:targetId/lifecycle', async (request, reply) => { const proxyId = await requireProxy(request, reply); if (!proxyId) return; const target = await store.getTarget((request.params as { targetId: string }).targetId); if (!target) return reply.code(404).send({ code: 'TARGET_NOT_FOUND', message: '目标服务器不存在' }); return { targetId: target.id, displayName: target.displayName, lifecycle: target.lifecycle, rawState: target.rawState, ready: target.ready, playerCount: target.playerCount, heartbeatAt: target.heartbeatAt, lastError: target.lastError }; });

const ticketSchema = z.object({ playerUuid: z.string().uuid(), playerName: z.string().max(32).optional(), ticketClass: z.enum(['online', 'offline']), snapshot: z.string().max(2000).optional() });
app.post('/api/v1/proxy/targets/:targetId/tickets', async (request, reply) => { const proxyId = await requireProxy(request, reply); if (!proxyId) return; const targetId = (request.params as { targetId: string }).targetId; if (!await store.getTarget(targetId)) return reply.code(404).send({ code: 'TARGET_NOT_FOUND', message: '目标服务器不存在' }); const parsed = ticketSchema.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ code: 'INVALID_BODY', message: '票据格式无效' }); const ticket = await store.upsertTicket({ targetId, ...parsed.data, ttlSeconds: config.ticketTtlSeconds }); const summary = summarizeTickets(await store.listTickets(targetId), ticket.playerUuid); return { ticket, queue: summary }; });
app.get('/api/v1/proxy/targets/:targetId/tickets/player/:playerUuid', async (request, reply) => { const proxyId = await requireProxy(request, reply); if (!proxyId) return; const { targetId, playerUuid } = request.params as { targetId: string; playerUuid: string }; if (!z.string().uuid().safeParse(playerUuid).success) return reply.code(400).send({ code: 'INVALID_PLAYER_UUID', message: '玩家 UUID 无效' }); if (!await store.getTarget(targetId)) return reply.code(404).send({ code: 'TARGET_NOT_FOUND', message: '目标服务器不存在' }); const ticket = await store.findActiveTicket(targetId, playerUuid); if (!ticket) return reply.code(404).send({ code: 'TICKET_NOT_FOUND', message: '没有活动票据' }); return { ticket }; });
app.post('/api/v1/proxy/targets/:targetId/tickets/:ticketId/events', async (request, reply) => { const proxyId = await requireProxy(request, reply); if (!proxyId) return; const { targetId, ticketId } = request.params as { targetId: string; ticketId: string }; const parsed = z.object({ event: z.enum(['promoted', 'transferred', 'failed', 'expired']), snapshot: z.string().max(2000).optional() }).safeParse(request.body); if (!parsed.success) return reply.code(400).send({ code: 'INVALID_BODY', message: '票据事件无效' }); const ticket = await store.updateTicketEvent(targetId, ticketId, parsed.data.event, parsed.data.snapshot); if (!ticket) return reply.code(404).send({ code: 'TICKET_NOT_FOUND', message: '票据不存在' }); return { ticket, queue: summarizeTickets(await store.listTickets(targetId), ticket.playerUuid) }; });
app.get('/api/v1/proxy/targets/:targetId/queue', async (request, reply) => { const proxyId = await requireProxy(request, reply); if (!proxyId) return; const targetId = (request.params as { targetId: string }).targetId; if (!await store.getTarget(targetId)) return reply.code(404).send({ code: 'TARGET_NOT_FOUND', message: '目标服务器不存在' }); const playerUuid = (request.query as { playerUuid?: string }).playerUuid; return summarizeTickets(await store.listTickets(targetId), playerUuid); });

app.get('/api/v1/admin/dashboard', async (request, reply) => { if (!requireAdmin(request, reply)) return; const targets = await store.listTargets(); const counts = Object.fromEntries(['READY', 'STARTING', 'RUNNING_UNREADY', 'IDLE_COUNTDOWN', 'STOP_REQUESTED', 'STOPPING', 'OFFLINE', 'FAILED', 'SUSPENDED', 'BLOCKED', 'API_ERROR', 'UNKNOWN'].map((state) => [state, targets.filter((target) => target.lifecycle === state).length])); const enriched = await Promise.all(targets.map(async (target) => ({ ...target, queue: summarizeTickets(await store.listTickets(target.id)) }))); const proxies = await store.listProxies(); const staleProxyCount = proxies.filter((proxy) => !proxy.lastSeenAt || Date.now() - Date.parse(proxy.lastSeenAt) > config.heartbeatFreshnessSeconds * 1000).length; return { counts, targets: enriched, proxies, staleProxyCount }; });

const powerSchema = z.object({ signal: z.enum(['start', 'stop', 'restart']) });
app.post('/api/v1/admin/targets/:targetId/power', async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  const targetId = (request.params as { targetId: string }).targetId;
  const target = await store.getTarget(targetId);
  if (!target) return reply.code(404).send({ code: 'TARGET_NOT_FOUND', message: '目标服务器不存在' });
  const parsed = powerSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ code: 'INVALID_BODY', message: '电源操作无效' });
  if (!target.panelServerIdentifier || !config.pterodactylUrl || !config.pterodactylToken) return reply.code(503).send({ code: 'PTERODACTYL_NOT_CONFIGURED', message: '未配置 Pterodactyl 连接' });
  const operationId = await store.beginPowerOperation(target.id, parsed.data.signal);
  try {
    await pterodactyl.power(target.panelServerIdentifier, parsed.data.signal);
    if (parsed.data.signal === 'start' || parsed.data.signal === 'restart') await store.updateTargetLifecycle(target.id, 'start_requested', false);
    if (parsed.data.signal === 'stop') await store.updateTargetLifecycle(target.id, 'stop_requested', false);
    return { accepted: true, targetId, signal: parsed.data.signal };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Pterodactyl 电源操作失败';
    await store.failPowerOperation(operationId, message);
    await store.updateTargetLifecycle(target.id, 'api_error', false, message);
    return reply.code(502).send({ code: 'PTERODACTYL_ERROR', message: 'Pterodactyl 电源操作失败' });
  }
});

app.post('/api/v1/admin/targets/:targetId/test', async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  const targetId = (request.params as { targetId: string }).targetId;
  const target = await store.getTarget(targetId);
  if (!target) return reply.code(404).send({ code: 'TARGET_NOT_FOUND', message: '目标服务器不存在' });
  if (!target.panelServerIdentifier || !config.pterodactylUrl || !config.pterodactylToken) return reply.code(503).send({ code: 'PTERODACTYL_NOT_CONFIGURED', message: '未配置 Pterodactyl 连接' });
  try {
    const resources = await pterodactyl.resources(target.panelServerIdentifier);
    return { ok: true, targetId, currentState: resources.current_state, suspended: resources.is_suspended === true || String(resources.is_suspended).toLowerCase() === 'true' || String(resources.is_suspended) === '1' };
  } catch {
    return reply.code(502).send({ code: 'PTERODACTYL_ERROR', message: 'Pterodactyl 连接测试失败' });
  }
});

const targetCreateSchema = z.object({
  id: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, 'ID 只能包含字母、数字、下划线和短横线'),
  slug: z.string().trim().min(1).max(128),
  displayName: z.string().trim().min(1).max(128),
  aliases: z.array(z.string().trim().min(1).max(255)).min(1).max(16),
  panelServerIdentifier: z.string().trim().min(1).max(128),
  backendHost: z.string().trim().min(1).max(255),
  backendPort: z.coerce.number().int().min(1).max(65535),
  software: z.string().trim().max(64).optional(),
  loader: z.string().trim().max(64).optional(),
  minecraftVersion: z.string().trim().max(32).optional(),
  entryProfile: z.string().trim().max(128).optional(),
  startupTimeoutSeconds: z.coerce.number().int().min(30).max(86400).optional(),
  idleTimeoutSeconds: z.coerce.number().int().min(60).max(604800).optional(),
});
app.post('/api/v1/admin/targets', async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  const parsed = targetCreateSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ code: 'INVALID_BODY', message: '服务器信息格式无效', details: parsed.error.flatten() });
  const aliases = [...new Set(parsed.data.aliases.map(normalizeHostname).filter(Boolean))];
  if (aliases.length !== parsed.data.aliases.length) return reply.code(400).send({ code: 'INVALID_ALIASES', message: '域名不能为空且不能重复' });
  try {
    const target = await store.createTarget({ ...parsed.data, aliases, panelServerIdentifier: parsed.data.panelServerIdentifier || undefined, backendHost: parsed.data.backendHost || undefined, software: parsed.data.software || undefined, loader: parsed.data.loader || undefined, minecraftVersion: parsed.data.minecraftVersion || undefined, entryProfile: parsed.data.entryProfile || undefined });
    if (!target) return reply.code(409).send({ code: 'TARGET_EXISTS', message: '服务器 ID、slug 或域名已存在' });
    return reply.code(201).send({ target });
  } catch (error) {
    if ((error as { code?: string }).code === 'ER_DUP_ENTRY') return reply.code(409).send({ code: 'TARGET_EXISTS', message: '服务器 ID、slug 或域名已存在' });
    throw error;
  }
});

app.put('/api/v1/admin/targets/:targetId', async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  const targetId = (request.params as { targetId: string }).targetId;
  const parsed = targetCreateSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ code: 'INVALID_BODY', message: '服务器信息格式无效', details: parsed.error.flatten() });
  if (parsed.data.id !== targetId) return reply.code(400).send({ code: 'TARGET_ID_IMMUTABLE', message: '服务器 ID 创建后不可修改' });
  const aliases = [...new Set(parsed.data.aliases.map(normalizeHostname).filter(Boolean))];
  if (aliases.length !== parsed.data.aliases.length) return reply.code(400).send({ code: 'INVALID_ALIASES', message: '域名不能为空且不能重复' });
  try {
    const target = await store.updateTarget(targetId, { ...parsed.data, aliases, panelServerIdentifier: parsed.data.panelServerIdentifier || undefined, backendHost: parsed.data.backendHost || undefined, software: parsed.data.software || undefined, loader: parsed.data.loader || undefined, minecraftVersion: parsed.data.minecraftVersion || undefined, entryProfile: parsed.data.entryProfile || undefined });
    if (!target) return reply.code(409).send({ code: 'TARGET_CONFLICT_OR_NOT_FOUND', message: '服务器不存在，或 ID、slug、域名与其他服务器冲突' });
    return { target };
  } catch (error) {
    if ((error as { code?: string }).code === 'ER_DUP_ENTRY') return reply.code(409).send({ code: 'TARGET_EXISTS', message: '服务器 ID、slug 或域名已存在' });
    throw error;
  }
});

app.delete('/api/v1/admin/targets/:targetId', async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  const targetId = (request.params as { targetId: string }).targetId;
  const target = await store.getTarget(targetId);
  if (!target) return reply.code(404).send({ code: 'TARGET_NOT_FOUND', message: '目标服务器不存在' });
  if (!await store.deleteTarget(targetId)) return reply.code(404).send({ code: 'TARGET_NOT_FOUND', message: '目标服务器不存在' });
  return { deleted: true, targetId };
});

const proxyCreateSchema = z.object({ name: z.string().trim().min(1).max(128) });
const MAX_PROXY_ID_SUFFIX_LENGTH = 48;
function generatedProxyId(name: string): string { const readable = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, MAX_PROXY_ID_SUFFIX_LENGTH); return `proxy-${readable || randomUUID().slice(0, 8)}`; }
function newProxyToken(): string { return randomBytes(32).toString('hex'); }

app.get('/api/v1/admin/proxies', async (request, reply) => { if (!requireAdmin(request, reply)) return; return { proxies: await store.listProxies() }; });
app.post('/api/v1/admin/proxies', async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  const parsed = proxyCreateSchema.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ code: 'INVALID_BODY', message: '代理名称不能为空且不能超过 128 个字符' });
  const token = newProxyToken();
  let id = generatedProxyId(parsed.data.name);
  let proxy = await store.createProxy({ id, name: parsed.data.name, token });
  if (!proxy) { id = `proxy-${randomUUID().slice(0, 12)}`; proxy = await store.createProxy({ id, name: parsed.data.name, token }); }
  if (!proxy) return reply.code(409).send({ code: 'PROXY_EXISTS', message: '代理 ID 已存在，请重试' });
  return reply.code(201).send({ proxy, token });
});
app.post('/api/v1/admin/proxies/:proxyId/rotate', async (request, reply) => { if (!requireAdmin(request, reply)) return; const proxyId = (request.params as { proxyId: string }).proxyId; const token = newProxyToken(); const proxy = await store.rotateProxyToken(proxyId, token); if (!proxy) return reply.code(404).send({ code: 'PROXY_NOT_FOUND', message: '代理不存在' }); return { proxy, token }; });

app.setNotFoundHandler((request, reply) => { if (request.method === 'GET' && existsSync(join(webRoot, 'index.html'))) return reply.sendFile('index.html'); return reply.code(404).send({ code: 'NOT_FOUND', message: '接口不存在' }); });
const close = async () => { await lifecycle.stop(); await app.close(); await store.close(); };
process.once('SIGTERM', () => void close().then(() => process.exit(0))); process.once('SIGINT', () => void close().then(() => process.exit(0)));
await app.listen({ host: config.host, port: config.port });
lifecycle.start();
