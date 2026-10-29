import 'dotenv/config';

function integerSetting(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} 必须是 ${minimum} 到 ${maximum} 之间的整数`);
  return value;
}

export interface AppConfig {
  host: string;
  port: number;
  sqlType: 'mysql' | 'memory';
  sqlAddress?: string;
  adminApiToken?: string;
  proxyTokens: Map<string, string>;
  pterodactylUrl?: string;
  pterodactylToken?: string;
  pterodactylTimeoutMs: number;
  heartbeatFreshnessSeconds: number;
  lifecyclePollSeconds: number;
  readinessProbeTimeoutMs: number;
  autoStopEnabled: boolean;
  ticketTtlSeconds: number;
}

export function loadConfig(): AppConfig {
  const sqlType = (process.env.SQL_TYPE ?? process.env.STORAGE_MODE ?? 'mysql').trim().toLowerCase() as 'mysql' | 'memory';
  if (sqlType !== 'mysql' && sqlType !== 'memory') throw new Error('SQL_TYPE 必须是 mysql 或 memory；生产环境请使用 mysql');
  const sqlAddress = process.env.SQL_ADDRESS ?? process.env.DATABASE_URL;
  if (sqlType === 'mysql' && !sqlAddress) throw new Error('缺少环境变量 SQL_ADDRESS（兼容变量：DATABASE_URL）');
  const proxyTokens = new Map<string, string>();
  for (const item of (process.env.PROXY_TOKENS ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const separator = item.indexOf('=');
    const id = separator < 0 ? '' : item.slice(0, separator).trim();
    const token = separator < 0 ? '' : item.slice(separator + 1).trim();
    if (id && token) proxyTokens.set(id, token);
  }
  const autoStopValue = (process.env.AUTO_STOP_ENABLED ?? 'true').trim().toLowerCase();
  if (autoStopValue !== 'true' && autoStopValue !== 'false') throw new Error('AUTO_STOP_ENABLED 必须是 true 或 false');
  const pterodactylUrl = process.env.PTERODACTYL_URL?.trim().replace(/\/$/, '');
  if (pterodactylUrl && !/^https?:\/\//i.test(pterodactylUrl)) throw new Error('PTERODACTYL_URL 必须使用 http:// 或 https://');
  return {
    host: process.env.HOST?.trim() || '0.0.0.0',
    port: integerSetting('PORT', 8080, 1, 65535),
    sqlType,
    sqlAddress,
    adminApiToken: process.env.ADMIN_API_TOKEN?.trim() || undefined,
    proxyTokens,
    pterodactylUrl,
    pterodactylToken: process.env.PTERODACTYL_API_TOKEN?.trim() || undefined,
    pterodactylTimeoutMs: integerSetting('PTERODACTYL_TIMEOUT_MS', 5000, 250, 120000),
    heartbeatFreshnessSeconds: integerSetting('HEARTBEAT_FRESHNESS_SECONDS', 45, 15, 3600),
    lifecyclePollSeconds: integerSetting('LIFECYCLE_POLL_SECONDS', 5, 1, 300),
    readinessProbeTimeoutMs: integerSetting('READINESS_PROBE_TIMEOUT_MS', 2000, 100, 60000),
    autoStopEnabled: autoStopValue === 'true',
    ticketTtlSeconds: integerSetting('TICKET_TTL_SECONDS', 1800, 60, 604800),
  };
}
