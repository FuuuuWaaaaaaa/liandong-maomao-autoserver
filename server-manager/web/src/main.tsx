import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

type Target = { id: string; slug: string; displayName: string; aliases: string[]; lifecycle: string; rawState: string; ready: boolean; playerCount: number; heartbeatAt?: string; lastError?: string; entryProfile?: string; panelServerIdentifier?: string; backendHost?: string; backendPort?: number; software?: string; loader?: string; minecraftVersion?: string };
type Dashboard = { counts: Record<string, number>; targets: Target[] };
type ProxySummary = { id: string; name: string; tokenHint?: string; enabled: boolean; lastSeenAt?: string; pluginVersion?: string; apiVersion?: string };
type ProxyCredential = { proxy: ProxySummary; token: string };
type TargetDraft = { id: string; slug: string; displayName: string; aliases: string; panelServerIdentifier: string; backendHost: string; backendPort: string; software: string; loader: string; minecraftVersion: string; entryProfile: string };
const labels: Record<string, string> = { READY: '就绪', STARTING: '启动中', STOPPING: '停止中', OFFLINE: '离线', FAILED: '失败', UNKNOWN: '未知', RUNNING_UNREADY: '运行中·等待游戏', IDLE_COUNTDOWN: '空闲倒计时' };
const nav = ['总览', '服务器', '路由与档案', '活动记录', '设置'];
const MAX_BACKGROUND_BYTES = 3 * 1024 * 1024;

function statusClass(state: string) { return `status status-${state.toLowerCase().replaceAll('_', '-')}`; }
function formatAge(value?: string) { if (!value) return '没有心跳'; const seconds = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1000)); return `${seconds} 秒前`; }
function StatusBadge({ state }: { state: string }) { return <span className={statusClass(state)}><i />{labels[state] ?? state}</span>; }
async function adminRequest<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) } });
  const body = await response.json().catch(() => ({})) as { message?: string };
  if (!response.ok) throw new Error(body.message ?? `管理员接口请求失败（HTTP ${response.status}）`);
  return body as T;
}

function AdminTokenForm({ initialToken, onSave }: { initialToken: string; onSave: (token: string) => void }) {
  const [value, setValue] = useState(initialToken);
  useEffect(() => setValue(initialToken), [initialToken]);
  return <form className="token-form" onSubmit={(event) => { event.preventDefault(); onSave(value); }}><label htmlFor="admin-token">管理员令牌</label><div className="token-controls"><input id="admin-token" className="token-input" type="password" value={value} onChange={(event) => setValue(event.target.value)} placeholder="输入 ADMIN_API_TOKEN" autoComplete="off" /><button className="primary-button" type="submit">保存并验证</button></div><small>此处只验证管理器已配置的令牌；修改服务端环境变量后必须重启管理器。验证成功后才会保存在当前浏览器。</small></form>;
}

function ServerTable({ targets }: { targets: Target[] }) {
  return <div className="table-wrap"><table><thead><tr><th>服务器</th><th>状态</th><th>玩家</th><th>心跳</th><th>入口档案</th><th>操作</th></tr></thead><tbody>{targets.map((target) => <tr key={target.id}><td><div className="server-name"><span className="server-dot" /><div><strong>{target.displayName}</strong><small>{target.aliases[0] ?? target.id}</small></div></div></td><td><StatusBadge state={target.lifecycle} /></td><td><strong>{target.playerCount}</strong><span className="muted"> 人</span></td><td><span className="muted">{formatAge(target.heartbeatAt)}</span></td><td><span className="profile-chip">{target.entryProfile ?? '默认大厅'}</span></td><td><button className="row-action" title="查看服务器详情" aria-label={`查看 ${target.displayName} 详情`}>→</button></td></tr>)}</tbody></table>{targets.length === 0 && <div className="empty">暂无服务器配置，请先完成管理员认证。</div>}</div>;
}

function TargetCreateForm({ error, onCreate }: { error: string; onCreate: (draft: TargetDraft) => Promise<boolean> }) {
  const empty: TargetDraft = { id: '', slug: '', displayName: '', aliases: '', panelServerIdentifier: '', backendHost: '', backendPort: '', software: '', loader: '', minecraftVersion: '', entryProfile: 'default-lobby' };
  const [draft, setDraft] = useState(empty);
  const update = (key: keyof TargetDraft, value: string) => setDraft((current) => ({ ...current, [key]: value }));
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const aliases = draft.aliases.split(/[\n,]/).map((value) => value.trim()).filter(Boolean);
    if (!draft.id.trim() || !draft.displayName.trim() || aliases.length === 0) return;
    const ok = await onCreate({ ...draft, slug: draft.slug.trim() || draft.id.trim(), aliases: aliases.join(',') });
    if (ok) setDraft(empty);
  };
  return <article className="panel glass-surface target-create-card"><div className="panel-heading"><div><p className="eyebrow">目标配置</p><h2>添加托管服务器</h2></div></div><form className="target-create-form" onSubmit={submit}><div className="target-form-grid"><label>服务器 ID<input className="token-input" value={draft.id} onChange={(event) => update('id', event.target.value)} placeholder="server1" /></label><label>显示名称<input className="token-input" value={draft.displayName} onChange={(event) => update('displayName', event.target.value)} placeholder="生存服务器" /></label><label>Slug<input className="token-input" value={draft.slug} onChange={(event) => update('slug', event.target.value)} placeholder="留空则使用服务器 ID" /></label><label>入口档案<input className="token-input" value={draft.entryProfile} onChange={(event) => update('entryProfile', event.target.value)} placeholder="default-lobby" /></label><label className="target-form-wide">玩家进入的域名<input className="token-input" value={draft.aliases} onChange={(event) => update('aliases', event.target.value)} placeholder="survival.example.com，可用逗号分隔多个域名" /></label><label>Pterodactyl Server Identifier<input className="token-input" value={draft.panelServerIdentifier} onChange={(event) => update('panelServerIdentifier', event.target.value)} placeholder="面板服务器的 UUID 或 identifier" /></label><label>后端地址<input className="token-input" value={draft.backendHost} onChange={(event) => update('backendHost', event.target.value)} placeholder="例如 10.0.0.20" /></label><label>后端端口<input className="token-input" inputMode="numeric" value={draft.backendPort} onChange={(event) => update('backendPort', event.target.value)} placeholder="25565" /></label><label>软件 / 加载器<input className="token-input" value={draft.software} onChange={(event) => update('software', event.target.value)} placeholder="Paper / Forge" /></label><label>游戏版本<input className="token-input" value={draft.minecraftVersion} onChange={(event) => update('minecraftVersion', event.target.value)} placeholder="1.21.1" /></label></div><p className="target-form-help">域名必须是玩家实际连接到 Velocity 的 hostname；Pterodactyl identifier 可在面板服务器详情或 API 地址中查看。添加后代理会在下一次配置刷新（默认 30 秒）收到该路由。</p>{error && <p className="settings-error" role="alert">{error}</p>}<button className="primary-button" type="submit">保存服务器</button></form></article>;
}

function DashboardView({ data, error, adminToken, onSaveToken }: { data: Dashboard | null; error: string; adminToken: string; onSaveToken: (token: string) => void }) {
  const counts = data?.counts ?? {};
  const targets = data?.targets ?? [];
  return <>
    {error && <div className="notice warning"><span>!</span><div><strong>需要管理员会话</strong><p>{error}</p><AdminTokenForm initialToken={adminToken} onSave={onSaveToken} /></div></div>}
    <section className="metric-grid">{[['READY', '就绪服务器', '↗'], ['STARTING', '正在启动', '◌'], ['STOPPING', '正在停止', '↘'], ['OFFLINE', '离线服务器', '○']].map(([key, title, icon]) => <article className="metric glass-surface" key={key}><div className="metric-head"><span>{title}</span><span className="metric-icon">{icon}</span></div><strong>{counts[key] ?? 0}</strong><small>{key === 'READY' ? '接收玩家中' : key === 'OFFLINE' ? '等待下一次唤醒' : '需要持续观察'}</small></article>)}</section>
    <section className="content-grid"><article className="panel glass-surface servers-panel"><div className="panel-heading"><div><p className="eyebrow">实时状态</p><h2>托管服务器</h2></div><button className="quiet-button" onClick={() => location.reload()}>刷新 <span>↻</span></button></div><ServerTable targets={targets} /></article><aside className="panel glass-surface activity-panel"><div className="panel-heading"><div><p className="eyebrow">安全提示</p><h2>运行守则</h2></div></div><div className="rule-list"><div><span className="rule-icon blue">⌁</span><div><strong>心跳新鲜度</strong><p>缺失或过期的代理心跳不会触发自动关服。</p></div></div><div><span className="rule-icon amber">◷</span><div><strong>启动确认</strong><p>面板显示 running 后，还要通过 Minecraft 就绪探测。</p></div></div><div><span className="rule-icon green">✓</span><div><strong>优雅停止</strong><p>空闲计时完成后只发送 graceful stop。</p></div></div></div></aside></section>
  </>;
}

function ServersView({ targets, createError, onCreate }: { targets: Target[]; createError: string; onCreate: (draft: TargetDraft) => Promise<boolean> }) {
  const ready = targets.filter((target) => target.lifecycle === 'READY').length;
  const players = targets.reduce((total, target) => total + target.playerCount, 0);
  return <section className="view-stack"><div className="page-toolbar glass-surface"><div><p className="eyebrow">运行资源</p><h2>服务器列表</h2><p>查看所有托管目标的生命周期、玩家数和入口档案。</p></div><div className="toolbar-stats"><span><strong>{targets.length}</strong> 个目标</span><span><strong>{ready}</strong> 个就绪</span><span><strong>{players}</strong> 名玩家</span></div></div><TargetCreateForm error={createError} onCreate={onCreate} /><article className="panel glass-surface full-panel"><div className="panel-heading"><div><p className="eyebrow">目标清单</p><h2>全部服务器</h2></div><button className="quiet-button" onClick={() => location.reload()}>刷新 <span>↻</span></button></div><ServerTable targets={targets} /></article></section>;
}

function RoutesProfilesView({ targets }: { targets: Target[] }) {
  const routes = targets.flatMap((target) => target.aliases.map((hostname) => ({ hostname, target })));
  const profiles = [...new Set(targets.map((target) => target.entryProfile ?? '默认大厅'))];
  return <section className="view-stack"><div className="page-toolbar glass-surface"><div><p className="eyebrow">连接入口</p><h2>路由与档案</h2><p>域名决定目标服务器，入口档案决定等待中的兼容后端。</p></div><div className="toolbar-stats"><span><strong>{routes.length}</strong> 个域名</span><span><strong>{profiles.length}</strong> 个档案</span></div></div><div className="split-grid"><article className="panel glass-surface full-panel"><div className="panel-heading"><div><p className="eyebrow">Hostname</p><h2>域名路由</h2></div></div><div className="table-wrap"><table><thead><tr><th>接入域名</th><th>目标服务器</th><th>当前状态</th></tr></thead><tbody>{routes.map(({ hostname, target }) => <tr key={`${target.id}-${hostname}`}><td><code className="hostname">{hostname}</code></td><td><strong>{target.displayName}</strong><small className="table-subtitle">{target.id}</small></td><td><StatusBadge state={target.lifecycle} /></td></tr>)}</tbody></table>{routes.length === 0 && <div className="empty">暂无域名路由。</div>}</div></article><article className="panel glass-surface full-panel"><div className="panel-heading"><div><p className="eyebrow">Holding profile</p><h2>入口档案</h2></div></div><div className="profile-list">{profiles.map((profile) => <div className="profile-row" key={profile}><span className="profile-icon">⌁</span><div><strong>{profile}</strong><p>{targets.filter((target) => (target.entryProfile ?? '默认大厅') === profile).length} 个目标使用此等待入口</p></div><span className="profile-arrow">→</span></div>)}{profiles.length === 0 && <div className="empty">暂无入口档案。</div>}</div></article></div></section>;
}

function ActivityView({ targets }: { targets: Target[] }) {
  return <section className="view-stack"><div className="page-toolbar glass-surface"><div><p className="eyebrow">审计视图</p><h2>活动记录</h2><p>这里显示当前目标的生命周期快照；详细审计记录由管理器持久化。</p></div></div><article className="panel glass-surface full-panel"><div className="panel-heading"><div><p className="eyebrow">最近状态</p><h2>生命周期时间线</h2></div></div><div className="activity-list">{targets.map((target) => <div className="activity-item" key={target.id}><span className="activity-line" /><div><strong>{target.displayName} · {labels[target.lifecycle] ?? target.lifecycle}</strong><p>原始状态：{target.rawState}，玩家：{target.playerCount} 人，最近心跳：{formatAge(target.heartbeatAt)}</p></div><StatusBadge state={target.lifecycle} /></div>)}{targets.length === 0 && <div className="empty">暂无活动记录。</div>}</div></article></section>;
}

function ProxyPanel({ proxies, credential, error, onCreate, onRotate }: { proxies: ProxySummary[]; credential: ProxyCredential | null; error: string; onCreate: (name: string) => void; onRotate: (id: string) => void }) {
  const [name, setName] = useState('');
  const [copyMessage, setCopyMessage] = useState('');
  const snippet = credential ? `manager:\n  base-url: "${window.location.origin}"\n  proxy-id: "${credential.proxy.id}"\n  token: "${credential.token}"` : '';
  const copySnippet = () => { if (!snippet || !navigator.clipboard) return; void navigator.clipboard.writeText(snippet).then(() => setCopyMessage('配置片段已复制')).catch(() => setCopyMessage('复制失败，请手动复制')); };
  return <article className="settings-card glass-surface proxy-card"><div className="panel-heading"><div><p className="eyebrow">代理接入</p><h2>添加 Velocity 代理</h2></div><span className="settings-symbol">⌁</span></div><div className="settings-body proxy-body"><form className="proxy-create-form" onSubmit={(event) => { event.preventDefault(); const value = name.trim(); if (!value) return; onCreate(value); setName(''); }}><label htmlFor="proxy-name">代理名称</label><div className="token-controls"><input id="proxy-name" className="token-input" value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：主大厅代理" /><button className="primary-button" type="submit">生成代理凭证</button></div><small>系统会自动生成代理 ID 和随机令牌。令牌只在生成或重新生成后显示一次。</small></form>{error && <p className="settings-error" role="alert">{error}</p>}{credential && <div className="proxy-credential"><strong>请立即复制插件配置</strong><p>令牌不会再次通过列表接口返回。修改配置后重启 Velocity。</p><pre>{snippet}</pre><div className="settings-actions"><button className="primary-button" type="button" onClick={copySnippet}>复制 config.yml 片段</button>{copyMessage && <small className="copy-message">{copyMessage}</small>}</div></div>}<div className="proxy-list">{proxies.length === 0 ? <div className="empty">尚未添加代理。</div> : proxies.map((proxy) => <div className="proxy-row" key={proxy.id}><div><strong>{proxy.name}</strong><small>{proxy.id} · {proxy.tokenHint ?? '未显示令牌'} · {proxy.lastSeenAt ? `最近心跳 ${formatAge(proxy.lastSeenAt)}` : '尚未连接'}</small></div><button className="quiet-button" type="button" onClick={() => onRotate(proxy.id)}>重新生成令牌</button></div>)}</div></div></article>;
}

function SettingsPanel({ background, backgroundError, inputRef, onUpload, onClear, adminToken, onSaveToken, onClearToken, proxies, proxyCredential, proxyError, onCreateProxy, onRotateProxy }: { background: string; backgroundError: string; inputRef: React.RefObject<HTMLInputElement | null>; onUpload: (event: React.ChangeEvent<HTMLInputElement>) => void; onClear: () => void; adminToken: string; onSaveToken: (token: string) => void; onClearToken: () => void; proxies: ProxySummary[]; proxyCredential: ProxyCredential | null; proxyError: string; onCreateProxy: (name: string) => void; onRotateProxy: (id: string) => void }) {
  return <section className="settings-grid"><article className="settings-card glass-surface"><div className="panel-heading"><div><p className="eyebrow">外观</p><h2>自定义网页背景</h2></div><span className="settings-symbol">▧</span></div><div className="settings-body"><div className="background-preview" style={background ? { backgroundImage: `url(${background})` } : undefined}><span>{background ? '当前背景' : '默认玻璃背景'}</span></div><div className="settings-copy"><strong>上传一张你喜欢的图片</strong><p>图片只保存在当前浏览器，不会上传到服务器。建议使用 3 MB 以内的 JPG、PNG 或 WebP 图片。</p><input ref={inputRef} className="visually-hidden" type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={onUpload} /><div className="settings-actions"><button className="primary-button" onClick={() => inputRef.current?.click()}><span>▧</span> 上传图片</button>{background && <button className="quiet-button" onClick={onClear}>清除背景</button>}</div>{backgroundError && <p className="settings-error" role="alert">{backgroundError}</p>}</div></div></article><article className="settings-card glass-surface"><div className="panel-heading"><div><p className="eyebrow">主题</p><h2>显示偏好</h2></div><span className="settings-symbol">☼</span></div><div className="settings-body compact"><p>使用顶部的月亮或太阳按钮切换浅色与深色玻璃主题。主题和背景偏好都会保存在当前浏览器。</p></div></article><article className="settings-card glass-surface"><div className="panel-heading"><div><p className="eyebrow">访问控制</p><h2>管理员令牌</h2></div><span className="settings-symbol">⌁</span></div><div className="settings-body token-settings"><AdminTokenForm initialToken={adminToken} onSave={onSaveToken} /><button className="quiet-button token-clear" onClick={onClearToken}>清除浏览器令牌</button></div></article><ProxyPanel proxies={proxies} credential={proxyCredential} error={proxyError} onCreate={onCreateProxy} onRotate={onRotateProxy} /></section>;
}

function App() {
  const [dark, setDark] = useState(localStorage.getItem('theme') === 'dark');
  const [active, setActive] = useState('总览');
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState('');
  const [adminToken, setAdminToken] = useState(localStorage.getItem('admin-token') ?? '');
  const [proxies, setProxies] = useState<ProxySummary[]>([]);
  const [proxyCredential, setProxyCredential] = useState<ProxyCredential | null>(null);
  const [proxyError, setProxyError] = useState('');
  const [targetCreateError, setTargetCreateError] = useState('');
  const [background, setBackground] = useState(localStorage.getItem('custom-background') ?? '');
  const [backgroundError, setBackgroundError] = useState('');
  const backgroundInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; localStorage.setItem('theme', dark ? 'dark' : 'light'); }, [dark]);
  useEffect(() => { if (background) localStorage.setItem('custom-background', background); else localStorage.removeItem('custom-background'); }, [background]);
  const loadProxies = (token: string) => {
    if (!token) { setProxies([]); return; }
    adminRequest<{ proxies: ProxySummary[] }>(token, '/api/v1/admin/proxies').then((result) => { setProxies(result.proxies); setProxyError(''); }).catch((reason) => setProxyError(reason instanceof Error ? reason.message : '代理列表加载失败'));
  };
  const loadDashboard = (token: string) => {
    if (!token) { setData(null); setError('尚未设置管理员令牌'); return; }
    setError('');
    adminRequest<Dashboard>(token, '/api/v1/admin/dashboard').then((dashboard) => { setData(dashboard); loadProxies(token); }).catch((reason) => setError(reason instanceof Error ? reason.message : '管理员接口请求失败，请检查管理器地址和网络连接'));
  };
  useEffect(() => { loadDashboard(adminToken); }, []);
  const saveAdminToken = (token: string) => {
    const normalized = token.trim();
    if (!normalized) { setError('管理员令牌不能为空'); return; }
    setError('正在验证管理员令牌…');
    adminRequest<Dashboard>(normalized, '/api/v1/admin/dashboard').then((dashboard) => {
      localStorage.setItem('admin-token', normalized);
      setAdminToken(normalized);
      setData(dashboard);
      loadProxies(normalized);
      setError('');
    }).catch((reason) => setError(reason instanceof Error ? reason.message : '管理员接口请求失败，请检查管理器地址和网络连接'));
  };
  const createProxy = (name: string) => { setProxyError(''); adminRequest<ProxyCredential>(adminToken, '/api/v1/admin/proxies', { method: 'POST', body: JSON.stringify({ name }) }).then((result) => { setProxyCredential(result); loadProxies(adminToken); }).catch((reason) => setProxyError(reason instanceof Error ? reason.message : '代理创建失败')); };
  const rotateProxy = (id: string) => { setProxyError(''); adminRequest<ProxyCredential>(adminToken, `/api/v1/admin/proxies/${encodeURIComponent(id)}/rotate`, { method: 'POST' }).then((result) => { setProxyCredential(result); loadProxies(adminToken); }).catch((reason) => setProxyError(reason instanceof Error ? reason.message : '代理令牌重新生成失败')); };
  const createTarget = async (draft: TargetDraft) => {
    setTargetCreateError('');
    try {
      await adminRequest<{ target: Target }>(adminToken, '/api/v1/admin/targets', { method: 'POST', body: JSON.stringify({ id: draft.id.trim(), slug: draft.slug.trim(), displayName: draft.displayName.trim(), aliases: draft.aliases.split(',').map((value) => value.trim()).filter(Boolean), panelServerIdentifier: draft.panelServerIdentifier.trim() || undefined, backendHost: draft.backendHost.trim() || undefined, backendPort: draft.backendPort.trim() ? Number(draft.backendPort) : undefined, software: draft.software.trim() || undefined, loader: draft.loader.trim() || undefined, minecraftVersion: draft.minecraftVersion.trim() || undefined, entryProfile: draft.entryProfile.trim() || undefined }) });
      loadDashboard(adminToken);
      return true;
    } catch (reason) {
      setTargetCreateError(reason instanceof Error ? reason.message : '服务器创建失败');
      return false;
    }
  };
  const clearAdminToken = () => { localStorage.removeItem('admin-token'); setAdminToken(''); setData(null); setProxies([]); setProxyCredential(null); setError('已清除浏览器中的管理员令牌'); };
  const handleBackgroundUpload = (event: React.ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; event.target.value = ''; setBackgroundError(''); if (!file) return; if (!file.type.startsWith('image/')) { setBackgroundError('请选择图片文件。'); return; } if (file.size > MAX_BACKGROUND_BYTES) { setBackgroundError('图片不能超过 3 MB，请先压缩后再上传。'); return; } const reader = new FileReader(); reader.onload = () => setBackground(String(reader.result)); reader.onerror = () => setBackgroundError('图片读取失败，请换一张图片重试。'); reader.readAsDataURL(file); };
  const targets = data?.targets ?? [];
  const view = active === '设置' ? <SettingsPanel background={background} backgroundError={backgroundError} inputRef={backgroundInputRef} onUpload={handleBackgroundUpload} onClear={() => { setBackground(''); setBackgroundError(''); }} adminToken={adminToken} onSaveToken={saveAdminToken} onClearToken={clearAdminToken} proxies={proxies} proxyCredential={proxyCredential} proxyError={proxyError} onCreateProxy={createProxy} onRotateProxy={rotateProxy} /> : active === '服务器' ? <ServersView targets={targets} createError={targetCreateError} onCreate={createTarget} /> : active === '路由与档案' ? <RoutesProfilesView targets={targets} /> : active === '活动记录' ? <ActivityView targets={targets} /> : <DashboardView data={data} error={error} adminToken={adminToken} onSaveToken={saveAdminToken} />;
  return <div className={background ? 'app-shell has-custom-background' : 'app-shell'}>{background && <div className="custom-background" style={{ backgroundImage: `url(${background})` }} aria-hidden="true" />}<aside className="sidebar glass-surface"><div className="brand"><span className="brand-mark">猫</span><div><strong>联动猫猫</strong><small>按需开服控制台</small></div></div><nav>{nav.map((item, index) => <button key={item} className={active === item ? 'nav-item active' : 'nav-item'} onClick={() => setActive(item)}><span className="nav-icon">{['⌂', '▦', '⌁', '◷', '⚙'][index]}</span>{item}</button>)}</nav><div className="sidebar-footer"><span className="pulse" />控制面在线</div></aside><main className="main-content"><header className="topbar"><div><p className="eyebrow">运营控制台 / {active}</p><h1>{active}</h1></div><div className="top-actions"><button className="icon-button" title="自定义网页背景" aria-label="自定义网页背景" onClick={() => setActive('设置')}>▧</button><button className="icon-button" title="切换主题" aria-label="切换主题" onClick={() => setDark((value) => !value)}>{dark ? '☼' : '☾'}</button><div className="avatar">管</div></div></header>{view}</main></div>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
