import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { summarizeTickets } from './domain/queue.js';
import { MemoryStore, MysqlStore, type Store } from './store.js';
import { PterodactylClient } from './pterodactyl.js';

const config = loadConfig();
const store: Store = config.sqlType === 'mysql' ? await MysqlStore.connect(config.sqlAddress!) : new MemoryStore(config.proxyTokens);
const pterodactyl = new PterodactylClient(config.pterodactylUrl, config.pterodactylToken, config.pterodactylTimeoutMs);
const app = Fastify({ logger: true });
await app.register(cors, { origin: true });
const webRoot = join(process.cwd(), 'web', 'dist');
if (existsSync(webRoot)) await app.register(fastifyStatic, { root: webRoot, prefix: '/' });

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

app.get('/health/live', async () => ({ status: 'ok', service: 'liandong-maomao-server-manager' }));
app.get('/health/ready', async (_request, reply) => { try { await store.listTargets(); return { status: 'ready', sqlType: config.sqlType }; } catch { return reply.code(503).send({ status: 'not_ready' }); } });

app.get('/api/v1/proxy/config', async (request, reply) => { const proxyId = await requireProxy(request, reply); if (!proxyId) return; const targets = await store.listTargets(); return { apiVersion: 'v1', proxyId, queue: { transferNoticeSeconds: 5, transferStabilitySeconds: 2, heartbeatSeconds: 15 }, targets: targets.filter((target) => target.enabled).map((target) => ({ id: target.id, displayName: target.displayName, aliases: target.aliases, entryProfile: target.entryProfile, lifecycle: target.lifecycle, rawState: target.rawState, ready: target.ready })) }; });

const heartbeatSchema = z.object({ observedAt: z.string().datetime(), targets: z.array(z.object({ targetId: z.string().min(1), playerCount: z.number().int().min(0).max(100000), quality: z.enum(['fresh', 'unknown']).default('fresh') })) });
app.post('/api/v1/proxy/heartbeat', async (request, reply) => { const proxyId = await requireProxy(request, reply); if (!proxyId) return; const parsed = heartbeatSchema.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ code: 'INVALID_BODY', message: '心跳格式无效', details: parsed.error.flatten() }); const observed = Date.parse(parsed.data.observedAt); if (observed > Date.now() + 60_000 || Date.now() - observed > config.heartbeatFreshnessSeconds * 1000) return reply.code(400).send({ code: 'STALE_OBSERVATION', message: '观测时间不在允许范围内' }); await Promise.all(parsed.data.targets.map((item) => store.saveHeartbeat(proxyId, item.targetId, item.playerCount, parsed.data.observedAt, item.quality))); return { accepted: true, proxyId, observedAt: parsed.data.observedAt }; });

app.post('/api/v1/proxy/targets/:targetId/wake', async (request, reply) => { const proxyId = await requireProxy(request, reply); if (!proxyId) return; const targetId = (request.params as { targetId: string }).targetId; const key = request.headers['idempotency-key']?.toString() ?? `${proxyId}:${targetId}`; const result = await store.wakeTarget(targetId, key); if (!result.target) return reply.code(404).send({ code: result.reason ?? 'TARGET_NOT_FOUND', message: '目标服务器不存在' }); if (result.accepted && result.target.lifecycle === 'START_REQUESTED' && result.target.panelServerIdentifier && config.pterodactylUrl && config.pterodactylToken) { try { await pterodactyl.power(result.target.panelServerIdentifier, 'start'); } catch (error) { await store.updateTargetLifecycle(targetId, 'api_error', false, error instanceof Error ? error.message : 'Pterodactyl 请求失败'); return reply.code(502).send({ code: 'PTERODACTYL_ERROR', message: '唤醒请求未被面板接受' }); } } return { accepted: result.accepted, operationId: result.operationId, lifecycle: result.target.lifecycle, rawState: result.target.rawState, reason: result.reason }; });

app.get('/api/v1/proxy/targets/:targetId/lifecycle', async (request, reply) => { const proxyId = await requireProxy(request, reply); if (!proxyId) return; const target = await store.getTarget((request.params as { targetId: string }).targetId); if (!target) return reply.code(404).send({ code: 'TARGET_NOT_FOUND', message: '目标服务器不存在' }); return { targetId: target.id, displayName: target.displayName, lifecycle: target.lifecycle, rawState: target.rawState, ready: target.ready, playerCount: target.playerCount, heartbeatAt: target.heartbeatAt, lastError: target.lastError }; });

const ticketSchema = z.object({ playerUuid: z.string().uuid(), playerName: z.string().max(32).optional(), ticketClass: z.enum(['online', 'offline']), snapshot: z.string().max(2000).optional() });
app.post('/api/v1/proxy/targets/:targetId/tickets', async (request, reply) => { const proxyId = await requireProxy(request, reply); if (!proxyId) return; const targetId = (request.params as { targetId: string }).targetId; if (!await store.getTarget(targetId)) return reply.code(404).send({ code: 'TARGET_NOT_FOUND', message: '目标服务器不存在' }); const parsed = ticketSchema.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ code: 'INVALID_BODY', message: '票据格式无效' }); const ticket = await store.upsertTicket({ targetId, ...parsed.data }); const summary = summarizeTickets(await store.listTickets(targetId), ticket.playerUuid); return { ticket, queue: summary }; });
app.post('/api/v1/proxy/targets/:targetId/tickets/:ticketId/events', async (request, reply) => { const proxyId = await requireProxy(request, reply); if (!proxyId) return; const { targetId, ticketId } = request.params as { targetId: string; ticketId: string }; const parsed = z.object({ event: z.enum(['promoted', 'transferred', 'failed', 'expired']), snapshot: z.string().max(2000).optional() }).safeParse(request.body); if (!parsed.success) return reply.code(400).send({ code: 'INVALID_BODY', message: '票据事件无效' }); const ticket = await store.updateTicketEvent(targetId, ticketId, parsed.data.event, parsed.data.snapshot); if (!ticket) return reply.code(404).send({ code: 'TICKET_NOT_FOUND', message: '票据不存在' }); return { ticket, queue: summarizeTickets(await store.listTickets(targetId), ticket.playerUuid) }; });
app.get('/api/v1/proxy/targets/:targetId/queue', async (request, reply) => { const proxyId = await requireProxy(request, reply); if (!proxyId) return; const targetId = (request.params as { targetId: string }).targetId; if (!await store.getTarget(targetId)) return reply.code(404).send({ code: 'TARGET_NOT_FOUND', message: '目标服务器不存在' }); const playerUuid = (request.query as { playerUuid?: string }).playerUuid; return summarizeTickets(await store.listTickets(targetId), playerUuid); });

app.get('/api/v1/admin/dashboard', async (request, reply) => { if (!requireAdmin(request, reply)) return; const targets = await store.listTargets(); const counts = Object.fromEntries(['READY', 'STARTING', 'STOPPING', 'OFFLINE', 'FAILED', 'UNKNOWN'].map((state) => [state, targets.filter((target) => target.lifecycle === state).length])); return { counts, targets: targets.map((target) => ({ ...target, queue: summarizeTickets([]) })) }; });

app.setNotFoundHandler((request, reply) => { if (request.method === 'GET' && existsSync(join(webRoot, 'index.html'))) return reply.sendFile('index.html'); return reply.code(404).send({ code: 'NOT_FOUND', message: '接口不存在' }); });
const close = async () => { await app.close(); await store.close(); };
process.once('SIGTERM', () => void close().then(() => process.exit(0))); process.once('SIGINT', () => void close().then(() => process.exit(0)));
await app.listen({ host: config.host, port: config.port });
