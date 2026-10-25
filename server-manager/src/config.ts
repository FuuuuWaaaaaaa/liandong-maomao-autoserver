import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}

export interface AppConfig {
  host: string;
  port: number;
  storageMode: 'mysql' | 'memory';
  databaseUrl?: string;
  adminApiToken?: string;
  proxyTokens: Map<string, string>;
  pterodactylUrl?: string;
  pterodactylToken?: string;
  pterodactylTimeoutMs: number;
  heartbeatFreshnessSeconds: number;
}

export function loadConfig(): AppConfig {
  const storageMode = (process.env.STORAGE_MODE ?? 'mysql') as 'mysql' | 'memory';
  if (storageMode !== 'mysql' && storageMode !== 'memory') throw new Error('STORAGE_MODE 必须是 mysql 或 memory');
  const proxyTokens = new Map<string, string>();
  for (const item of (process.env.PROXY_TOKENS ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const [id, token] = item.split('=');
    if (id && token) proxyTokens.set(id, token);
  }
  return {
    host: process.env.HOST ?? '0.0.0.0',
    port: Number(process.env.PORT ?? 8080),
    storageMode,
    databaseUrl: storageMode === 'mysql' ? required('DATABASE_URL') : process.env.DATABASE_URL,
    adminApiToken: process.env.ADMIN_API_TOKEN,
    proxyTokens,
    pterodactylUrl: process.env.PTERODACTYL_URL,
    pterodactylToken: process.env.PTERODACTYL_API_TOKEN,
    pterodactylTimeoutMs: Number(process.env.PTERODACTYL_TIMEOUT_MS ?? 5000),
    heartbeatFreshnessSeconds: Number(process.env.HEARTBEAT_FRESHNESS_SECONDS ?? 45),
  };
}
