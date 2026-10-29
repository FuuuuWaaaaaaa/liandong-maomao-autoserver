export interface PterodactylResources { current_state: string; is_suspended?: boolean; [key: string]: unknown }

export class PterodactylClient {
  constructor(private readonly baseUrl: string | undefined, private readonly token: string | undefined, private readonly timeoutMs: number) {}
  isConfigured(): boolean { return Boolean(this.baseUrl && this.token); }
  private async request(path: string, init?: RequestInit): Promise<Response> {
    if (!this.baseUrl || !this.token) throw new Error('Pterodactyl 未配置');
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try { return await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, { ...init, signal: controller.signal, headers: { Authorization: `Bearer ${this.token}`, Accept: 'Application/vnd.pterodactyl.v1+json', 'Content-Type': 'application/json', ...(init?.headers ?? {}) } }); } finally { clearTimeout(timeout); }
  }
  async resources(identifier: string): Promise<PterodactylResources> { const response = await this.request(`/api/client/servers/${encodeURIComponent(identifier)}/resources`); if (!response.ok) throw new Error(`Pterodactyl 资源请求失败: ${response.status}`); const body = await response.json() as any; return body.attributes ?? body; }
  async power(identifier: string, signal: 'start' | 'stop' | 'restart'): Promise<void> { const response = await this.request(`/api/client/servers/${encodeURIComponent(identifier)}/power`, { method: 'POST', body: JSON.stringify({ signal }) }); if (!response.ok) throw new Error(`Pterodactyl 电源请求失败: ${response.status}`); }
}
