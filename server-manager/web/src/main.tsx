import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

type Target = { id: string; displayName: string; aliases: string[]; lifecycle: string; rawState: string; ready: boolean; playerCount: number; heartbeatAt?: string; lastError?: string; entryProfile?: string };
type Dashboard = { counts: Record<string, number>; targets: Target[] };
const labels: Record<string, string> = { READY: '就绪', STARTING: '启动中', STOPPING: '停止中', OFFLINE: '离线', FAILED: '失败', UNKNOWN: '未知', RUNNING_UNREADY: '运行中·等待游戏', IDLE_COUNTDOWN: '空闲倒计时' };
const nav = ['总览', '服务器', '路由与档案', '活动记录', '设置'];

function statusClass(state: string) { return `status status-${state.toLowerCase().replaceAll('_', '-')}`; }
function formatAge(value?: string) { if (!value) return '没有心跳'; const seconds = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1000)); return `${seconds} 秒前`; }

function App() {
  const [dark, setDark] = useState(localStorage.getItem('theme') === 'dark');
  const [active, setActive] = useState('总览');
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; localStorage.setItem('theme', dark ? 'dark' : 'light'); }, [dark]);
  useEffect(() => { fetch('/api/v1/admin/dashboard', { headers: { Authorization: `Bearer ${localStorage.getItem('admin-token') ?? ''}` } }).then(async (response) => { if (!response.ok) throw new Error('请在浏览器存储中设置管理员 API Token'); return response.json(); }).then(setData).catch((reason) => setError(reason.message)); }, []);
  const counts = useMemo(() => data?.counts ?? {}, [data]);
  return <div className="app-shell">
    <aside className="sidebar glass-surface">
      <div className="brand"><span className="brand-mark">双</span><div><strong>双龙</strong><small>按需开服控制台</small></div></div>
      <nav>{nav.map((item, index) => <button key={item} className={active === item ? 'nav-item active' : 'nav-item'} onClick={() => setActive(item)}><span className="nav-icon">{['⌂', '▦', '⌁', '◷', '⚙'][index]}</span>{item}</button>)}</nav>
      <div className="sidebar-footer"><span className="pulse" />控制面在线</div>
    </aside>
    <main className="main-content">
      <header className="topbar"><div><p className="eyebrow">运营控制台 / {active}</p><h1>{active}</h1></div><div className="top-actions"><button className="icon-button" title="切换主题" onClick={() => setDark((value) => !value)}>{dark ? '☼' : '☾'}</button><div className="avatar">管</div></div></header>
      {error && <div className="notice warning"><span>!</span><div><strong>需要管理员会话</strong><p>{error}</p></div></div>}
      <section className="metric-grid">{[['READY', '就绪服务器', '↗'], ['STARTING', '正在启动', '◌'], ['STOPPING', '正在停止', '↘'], ['OFFLINE', '离线服务器', '○']].map(([key, title, icon]) => <article className="metric glass-surface" key={key}><div className="metric-head"><span>{title}</span><span className="metric-icon">{icon}</span></div><strong>{counts[key] ?? 0}</strong><small>{key === 'READY' ? '接收玩家中' : key === 'OFFLINE' ? '等待下一次唤醒' : '需要持续观察'}</small></article>)}</section>
      <section className="content-grid"><article className="panel glass-surface servers-panel"><div className="panel-heading"><div><p className="eyebrow">实时状态</p><h2>托管服务器</h2></div><button className="quiet-button" onClick={() => location.reload()}>刷新 <span>↻</span></button></div><div className="table-wrap"><table><thead><tr><th>服务器</th><th>状态</th><th>玩家</th><th>心跳</th><th>入口档案</th><th>操作</th></tr></thead><tbody>{(data?.targets ?? []).map((target) => <tr key={target.id}><td><div className="server-name"><span className="server-dot" /><div><strong>{target.displayName}</strong><small>{target.aliases[0] ?? target.id}</small></div></div></td><td><span className={statusClass(target.lifecycle)}><i />{labels[target.lifecycle] ?? target.lifecycle}</span></td><td><strong>{target.playerCount}</strong><span className="muted"> 人</span></td><td><span className="muted">{formatAge(target.heartbeatAt)}</span></td><td><span className="profile-chip">{target.entryProfile ?? '默认大厅'}</span></td><td><button className="row-action" title="查看详情">→</button></td></tr>)}</tbody></table>{!data?.targets?.length && <div className="empty">暂无服务器数据，完成管理员认证后会显示实时状态。</div>}</div></article><aside className="panel glass-surface activity-panel"><div className="panel-heading"><div><p className="eyebrow">安全提示</p><h2>运行守则</h2></div></div><div className="rule-list"><div><span className="rule-icon blue">⌁</span><div><strong>心跳新鲜度</strong><p>缺失或过期的代理心跳不会触发自动关服。</p></div></div><div><span className="rule-icon amber">◷</span><div><strong>启动确认</strong><p>面板显示 running 后，还要通过 Minecraft 就绪探测。</p></div></div><div><span className="rule-icon green">✓</span><div><strong>优雅停止</strong><p>空闲计时完成后只发送 graceful stop。</p></div></div></div></aside></section>
    </main>
  </div>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
