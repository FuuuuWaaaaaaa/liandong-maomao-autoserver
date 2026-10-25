import 'dotenv/config';

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
}

export function loadConfig(): AppConfig {
  const sqlType = (process.env.SQL_TYPE ?? process.env.STORAGE_MODE ?? 'mysql').toLowerCase() as 'mysql' | 'memory';
  if (sqlType !== 'mysql' && sqlType !== 'memory') throw new Error('SQL_TYPE 必须是 mysql 或 memory；生产环境请使用 mysql');
  const sqlAddress = process.env.SQL_ADDRESS ?? process.env.DATABASE_URL;
  if (sqlType === 'mysql' && !sqlAddress) throw new Error('缺少环境变量 SQL_ADDRESS（兼容变量：DATABASE_URL）');
  const proxyTokens = new Map<string, string>();
  for (const item of (process.env.PROXY_TOKENS ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const [id, token] = item.split('=');
    if (id && token) proxyTokens.set(id, token);
  }
  return {
    host: process.env.HOST ?? '0.0.0.0',
    port: Number(process.env.PORT ?? 8080),
    sqlType,
    sqlAddress,
    adminApiToken: process.env.ADMIN_API_TOKEN?.trim() || undefined,
    proxyTokens,
    pterodactylUrl: process.env.PTERODACTYL_URL,
    pterodactylToken: process.env.PTERODACTYL_API_TOKEN,
    pterodactylTimeoutMs: Number(process.env.PTERODACTYL_TIMEOUT_MS ?? 5000),
    heartbeatFreshnessSeconds: Number(process.env.HEARTBEAT_FRESHNESS_SECONDS ?? 45),
  };
}
