import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { createBrowserSdk } from 'auth-mini/sdk/browser';
import type { AuthMiniApi, SessionSnapshot } from 'auth-mini/sdk/browser';
import { Activity, Bot, ChevronRight, Cpu, Database, Download, Files, HardDrive, KeyRound, LoaderCircle, MemoryStick, Network, Plus, RefreshCw, RotateCcw, Send, Server, Settings2, TerminalSquare } from 'lucide-react';
import { createContext, FormEvent, ReactNode, useContext, useEffect, useState } from 'react';
import { HashRouter, NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { createRoot } from 'react-dom/client';
import './styles.css';

declare global {
  interface Window {
    __MOBIUS_AUTH_URL: string | null;
  }
}

type Status = { machine_id: string; hostname: string; root_user_id: string; auth_url: string; openai_base_url: string };
type Settings = { default_model: string };
type Peer = { id: string; name: string; base_url: string; created_at: string };
type FileEntry = { name: string; path: string; kind: 'file' | 'directory'; size: number };
type ChatMessage = { role: string; content: string | null };
type AgentEvent = { type: 'tool_call'; call_id: string; name: string } | { type: 'tool_result'; call_id: string; name: string } | { type: 'complete'; message: ChatMessage } | { type: 'error'; error: string };
type ConversationItem = { kind: 'message'; message: ChatMessage } | { kind: 'tool'; call_id: string; name: string; complete: boolean };
type Session = SessionSnapshot;
type Resources = { sampled_at: number; cpu: { usage_percent: number; load_1m: number; logical_cpus: number }; memory: { used_bytes: number; total_bytes: number; available_bytes: number; process_used_bytes: number; other_used_bytes: number; usage_percent: number; swap_used_bytes: number; swap_total_bytes: number }; network: { receive_bytes_per_second: number; transmit_bytes_per_second: number; interfaces: number }; disk: { mount_point: string; used_bytes: number; total_bytes: number; available_bytes: number; usage_percent: number } | null; sqlite: { main_bytes: number; wal_bytes: number; shm_bytes: number; total_bytes: number; freelist_bytes: number; freelist_percent: number } };
type UpdateStatus = { current_version: string; latest_version: string | null; state: 'current' | 'ready'; detail: string };

const queryClient = new QueryClient();
type Language = 'en' | 'zh';
type Theme = 'light' | 'dark';
type Ui = { language: Language; theme: Theme; toggleLanguage: () => void; toggleTheme: () => void; t: (key: keyof typeof words.en) => string };
const words = {
  en: {
    console: 'Console', machines: 'Machines', files: 'Files', resources: 'Resources', signOut: 'Sign out', activeMachine: 'ACTIVE MACHINE', online: 'Online',
    session: 'Mobius session', whatShouldHappen: 'What should happen?', unrestrictedHint: 'This agent can inspect and change any file on the active machine.',
    outcomePlaceholder: 'Describe the outcome, not the steps…', machineTitle: 'Machines', machineDescription: 'Every enrolled server exposes its own unrestricted filesystem through the Mobius HTTP API.',
    thisMachine: 'This machine', connectedSession: 'Connected through the current browser session', noMachines: 'No remote machines yet. Add a Mobius server below to build the cluster.',
    enroll: 'Enroll a machine', name: 'Name', mobiusUrl: 'Mobius URL', addMachine: 'Add machine', check: 'Check', remove: 'Remove',
    fileTitle: 'Files', fileDescription: 'Browse the active machine without a project boundary.', open: 'Open', chooseFile: 'Choose a file to read or edit it.', save: 'Save',
    resourceTitle: 'System resources', resourceDescription: 'Live capacity and local database use on the active machine.', cpu: 'CPU', memory: 'Memory', network: 'Network', disk: 'Disk', sqlite: 'SQLite', load: '1m load', process: 'Mobius RSS', otherMemory: 'Other system use', available: 'Available', received: 'Received', transmitted: 'Transmitted', interfaces: 'Interfaces', mount: 'Mount', mainFile: 'Main', walFile: 'WAL', shmFile: 'SHM', reclaimable: 'Reclaimable', updateTitle: 'Automatic updates', updateDescription: 'Mobius downloads a verified Release for this machine. Apply it only when you choose to restart.', downloading: 'Checking for updates…', restartUpdate: 'Restart and update', currentVersion: 'Current version', settingsNav: 'Settings', settingsTitle: 'Settings', settingsDescription: 'Configure how this machine starts new agent turns.', modelTitle: 'Default model', modelDescription: 'Used for every new conversation request. Changes apply on the next message.', modelId: 'Model ID', modelIdHint: 'Use a model available to this OpenAI-compatible upstream.', saveChanges: 'Save changes', saved: 'Saved', language: '中文', theme: 'Dark', settings: 'Display settings', loadingMachine: 'Loading machine', connecting: 'Connecting…',
  },
  zh: {
    console: '控制台', machines: '机器', files: '文件', resources: '资源', signOut: '退出登录', activeMachine: '当前机器', online: '在线',
    session: 'Mobius 会话', whatShouldHappen: '你希望发生什么？', unrestrictedHint: '这个 Agent 可以检查和修改当前机器上的任何文件。',
    outcomePlaceholder: '描述你想要的结果，而不是具体步骤…', machineTitle: '机器', machineDescription: '每台已接入服务器都通过 Mobius HTTP API 暴露其完整文件系统。',
    thisMachine: '本机', connectedSession: '通过当前浏览器会话连接', noMachines: '尚未接入远程机器。在下方添加 Mobius 服务器来构建集群。',
    enroll: '接入机器', name: '名称', mobiusUrl: 'Mobius URL', addMachine: '添加机器', check: '检查', remove: '移除',
    fileTitle: '文件', fileDescription: '在没有项目边界的前提下浏览当前机器。', open: '打开', chooseFile: '选择一个文件以读取或编辑。', save: '保存',
    resourceTitle: '系统资源', resourceDescription: '当前机器的实时容量与本地数据库使用情况。', cpu: 'CPU', memory: '内存', network: '网络', disk: '磁盘', sqlite: 'SQLite', load: '1 分钟负载', process: 'Mobius RSS', otherMemory: '其他系统占用', available: '可用', received: '接收', transmitted: '发送', interfaces: '网卡', mount: '挂载点', mainFile: '主文件', walFile: 'WAL', shmFile: 'SHM', reclaimable: '可回收', updateTitle: '自动更新', updateDescription: 'Mobius 会下载并校验当前机器所需的 Release；仅在你点击重启时才安装。', downloading: '正在检查更新…', restartUpdate: '重启并更新', currentVersion: '当前版本', settingsNav: '设置', settingsTitle: '设置', settingsDescription: '配置此机器启动新 Agent 对话时使用的默认值。', modelTitle: '默认模型', modelDescription: '每条新对话请求都会使用它；保存后下一条消息立即生效。', modelId: '模型 ID', modelIdHint: '请输入当前 OpenAI 兼容上游可用的模型 ID。', saveChanges: '保存更改', saved: '已保存', language: 'EN', theme: '亮色', settings: '显示设置', loadingMachine: '正在载入机器', connecting: '正在连接…',
  },
} as const;
const UiContext = createContext<Ui | null>(null);

function UiProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<Language>(() => localStorage.getItem('mobius.language') === 'zh' ? 'zh' : 'en');
  const [theme, setTheme] = useState<Theme>(() => localStorage.getItem('mobius.theme') === 'dark' || (!localStorage.getItem('mobius.theme') && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light');
  useEffect(() => { document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en'; localStorage.setItem('mobius.language', language); }, [language]);
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('mobius.theme', theme); }, [theme]);
  const value: Ui = { language, theme, toggleLanguage: () => setLanguage((value) => value === 'en' ? 'zh' : 'en'), toggleTheme: () => setTheme((value) => value === 'light' ? 'dark' : 'light'), t: (key) => words[language][key] };
  return <UiContext.Provider value={value}>{children}</UiContext.Provider>;
}

function useUi() { const value = useContext(UiContext); if (!value) throw new Error('UI context is missing'); return value; }

function useBrowserSession(sdk: AuthMiniApi | null) {
  const [session, setSession] = useState<Session>(() => sdk?.session.getState() ?? anonymous());
  useEffect(() => {
    if (!sdk) return;
    setSession(sdk.session.getState());
    return sdk.session.onChange(setSession);
  }, [sdk]);
  return session;
}

function anonymous(): Session {
  return { status: 'anonymous', authenticated: false, sessionId: null, accessToken: null, refreshToken: null, receivedAt: null, expiresAt: null };
}

async function api<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...init?.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(body.error ?? response.statusText);
  }
  return response.json() as Promise<T>;
}

async function streamAgentTurn(token: string, messages: ChatMessage[], onEvent: (event: AgentEvent) => void) {
  const response = await fetch('/api/agent/turn', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ messages }) });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(body.error ?? response.statusText);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The agent did not start an event stream.');
  const decoder = new TextDecoder(); let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n'); buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const event = JSON.parse(line.slice(6)) as AgentEvent;
      onEvent(event);
      if (event.type === 'error') throw new Error(event.error);
    }
  }
}

function App() {
  const configuredAuthUrl = acceptRedirectSession() ?? window.__MOBIUS_AUTH_URL;
  const [sdk] = useState<AuthMiniApi | null>(() => configuredAuthUrl ? createBrowserSdk(configuredAuthUrl) : null);
  const session = useBrowserSession(sdk);

  if (!configuredAuthUrl) return <Bootstrap session={session} />;
  if (session.status === 'recovering') return <Center><LoaderCircle className="spin" size={22} /> Restoring your Auth Mini session…</Center>;
  if (!session.authenticated || !session.accessToken) return <SignIn session={session} />;
  return <Workspace sdk={sdk} token={session.accessToken} />;
}

function Bootstrap({ session }: { session: Session }) {
  const [authUrl, setAuthUrl] = useState(() => sessionStorage.getItem('mobius.auth_url') ?? '');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const signIn = () => {
    setError('');
    try { beginAuthRedirect(authUrl); } catch (cause) { setError(message(cause)); }
  };
  const setup = async (event: FormEvent) => {
    event.preventDefault();
    if (!session.accessToken) return setError('Sign in to Auth Mini before creating this Mobius root.');
    setBusy(true); setError('');
    try {
      await api<Status>('/api/setup', session.accessToken, { method: 'POST', body: JSON.stringify({ auth_url: authUrl, openai_api_key: apiKey, openai_base_url: baseUrl }) });
      location.reload();
    } catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  };

  return <main className="bootstrap-shell">
    <section className="bootstrap-copy">
      <div className="mark"><span>m</span> mobius</div>
      <h1>Give intent<br />a whole machine.</h1>
      <p>Mobius is an unrestricted AI surface for the machines you operate. This one-time setup binds this machine to your Auth Mini identity.</p>
      <p className="quiet">There is no project directory, sandbox, or permission layer to configure.</p>
    </section>
    <section className="setup-panel">
      <div className="panel-heading"><span>First machine</span><h2>Initialize Mobius</h2><p>Your verified Auth Mini user becomes this machine’s root operator.</p></div>
      <div className="field"><label htmlFor="auth-url">Auth Mini URL</label><input id="auth-url" value={authUrl} onChange={(event) => setAuthUrl(event.target.value)} placeholder="https://auth.example.com" autoComplete="url" /></div>
      <div className="auth-flow">
        <div className="flow-title"><KeyRound size={16} /> Authenticate root operator</div>
        <p className="auth-description">Mobius redirects to Auth Mini for email, passkey, and session recovery. The returned browser session is kept by the Auth Mini SDK.</p>
        <button type="button" className="secondary auth-button" onClick={signIn} disabled={busy}>Continue with Auth Mini <ChevronRight size={15} /></button>
        {session.authenticated && <div className="success-line">Authenticated. This account will become the root operator.</div>}
      </div>
      <form onSubmit={setup}>
        <div className="field"><label htmlFor="api-key">OpenAI API key</label><input id="api-key" value={apiKey} onChange={(event) => setApiKey(event.target.value)} type="password" placeholder="sk-…" autoComplete="off" /></div>
        <div className="field"><label htmlFor="base-url">OpenAI-compatible base URL</label><input id="base-url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} /></div>
        {error && <p className="form-error">{error}</p>}
        <button className="primary wide" disabled={busy || !session.authenticated}>Initialize this machine <ChevronRight size={16} /></button>
      </form>
    </section>
  </main>;
}

function SignIn({ session }: { session: Session }) {
  const [error, setError] = useState('');
  const signIn = () => { try { beginAuthRedirect(window.__MOBIUS_AUTH_URL!); } catch (cause) { setError(message(cause)); } };
  return <Center><section className="signin-card"><div className="mark"><span>m</span> mobius</div><h1>Return to the machine.</h1><p>Sign in through the configured Auth Mini server.</p>{error && <p className="form-error">{error}</p>}<button className="primary wide" onClick={signIn}>Continue with Auth Mini</button>{session.status === 'recovering' && <LoaderCircle className="spin" />}</section></Center>;
}

function Workspace({ sdk, token }: { sdk: AuthMiniApi | null; token: string }) {
  const navigate = useNavigate();
  const { t, toggleLanguage, toggleTheme } = useUi();
  const status = useQuery({ queryKey: ['status'], queryFn: () => api<Status>('/api/status', token) });
  return <div className="app-shell">
    <aside className="sidebar"><div className="mark"><span>m</span> mobius</div><nav><NavItem to="/console" icon={<TerminalSquare size={18} />} label={t('console')} /><NavItem to="/machines" icon={<Network size={18} />} label={t('machines')} /><NavItem to="/files" icon={<Files size={18} />} label={t('files')} /><NavItem to="/resources" icon={<Activity size={18} />} label={t('resources')} /><NavItem to="/settings" icon={<Settings2 size={18} />} label={t('settingsNav')} /></nav><div className="sidebar-bottom"><div className="machine-chip"><Server size={15} /><span>{status.data?.hostname ?? t('connecting')}</span></div><button className="signout" onClick={async () => { await sdk?.session.logout(); navigate('/console'); }}>{t('signOut')}</button></div></aside>
    <section className="work"><header><div><span className="machine-label">{t('activeMachine')}</span><strong>{status.data?.hostname ?? t('loadingMachine')}</strong></div><div className="header-right"><span className="live-dot" /> {t('online')}<span className="header-separator" /><button className="header-button" title={t('settings')} onClick={toggleLanguage}>{t('language')}</button><button className="header-button" title={t('settings')} onClick={toggleTheme}><Settings2 size={14} /> {t('theme')}</button></div></header><Routes><Route path="/console" element={<Console token={token} />} /><Route path="/machines" element={<Machines token={token} />} /><Route path="/files" element={<FilesPage token={token} />} /><Route path="/resources" element={<ResourcesPage token={token} />} /><Route path="/settings" element={<SettingsPage token={token} />} /><Route path="*" element={<Navigate to="/console" replace />} /></Routes></section>
  </div>;
}

function NavItem({ to, icon, label }: { to: string; icon: ReactNode; label: string }) { return <NavLink to={to} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>{icon}<span>{label}</span></NavLink>; }

function Console({ token }: { token: string }) {
  const { t } = useUi();
  const [conversation, setConversation] = useState<ConversationItem[]>([{ kind: 'message', message: { role: 'assistant', content: 'I am connected to this machine. Tell me the outcome you want to reach.' } }]);
  const [draft, setDraft] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const send = async (event: FormEvent) => {
    event.preventDefault(); if (!draft.trim() || busy) return;
    const next = [...conversation.filter((item): item is { kind: 'message'; message: ChatMessage } => item.kind === 'message').map((item) => item.message), { role: 'user', content: draft.trim() }];
    setConversation([...conversation, { kind: 'message', message: next[next.length - 1] }]); setDraft(''); setBusy(true); setError('');
    try {
      await streamAgentTurn(token, next, (event) => {
        if (event.type === 'tool_call') setConversation((items) => [...items, { kind: 'tool', call_id: event.call_id, name: event.name, complete: false }]);
        if (event.type === 'tool_result') setConversation((items) => items.map((item) => item.kind === 'tool' && item.call_id === event.call_id ? { ...item, complete: true } : item));
        if (event.type === 'complete') setConversation((items) => [...items, { kind: 'message', message: event.message }]);
      });
    } catch (cause) { setError(message(cause)); } finally { setBusy(false); }
  };
  return <main className="console"><div className="console-intro"><span>{t('session')}</span><h1>{t('whatShouldHappen')}</h1><p>{t('unrestrictedHint')}</p></div><div className="conversation">{conversation.map((item, index) => item.kind === 'message' ? <article key={index} className={`message ${item.message.role}`}><div className="message-role">{item.message.role === 'assistant' ? <Bot size={16} /> : 'You'}</div><div>{item.message.content ?? 'Working with machine tools…'}</div></article> : <article className={`tool-activity ${item.complete ? 'complete' : ''}`} key={item.call_id}><div><TerminalSquare size={15} /> {item.complete ? 'Completed' : 'Calling'} {item.name}</div></article>)}{busy && <article className="message assistant"><div className="message-role"><Bot size={16} /> Agent</div><LoaderCircle className="spin" size={17} /></article>}</div>{error && <p className="form-error">{error}</p>}<form className="composer" onSubmit={send}><textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder={t('outcomePlaceholder')} rows={2} /><button className="primary" aria-label="Send request" disabled={busy}><Send size={17} /></button></form></main>;
}

function Machines({ token }: { token: string }) {
  const { t } = useUi();
  const peers = useQuery({ queryKey: ['peers'], queryFn: () => api<Peer[]>('/api/peers', token) }); const [name, setName] = useState(''); const [url, setUrl] = useState(''); const [error, setError] = useState('');
  const add = async (event: FormEvent) => { event.preventDefault(); setError(''); try { await api('/api/peers', token, { method: 'POST', body: JSON.stringify({ name, base_url: url }) }); setName(''); setUrl(''); await peers.refetch(); } catch (cause) { setError(message(cause)); } };
  return <main className="page"><div className="page-title"><div><h1>{t('machineTitle')}</h1><p>{t('machineDescription')}</p></div></div><section className="machine-list"><div className="machine-row self"><div className="machine-icon"><Server size={18} /></div><div><strong>{t('thisMachine')}</strong><p>{t('connectedSession')}</p></div><span className="status-pill">{t('online')}</span></div>{peers.data?.map((peer) => <PeerRow key={peer.id} peer={peer} token={token} onChanged={() => peers.refetch()} />)}{peers.data?.length === 0 && <div className="empty">{t('noMachines')}</div>}</section><form className="add-peer" onSubmit={add}><div className="section-title"><Plus size={18} /><h2>{t('enroll')}</h2></div><div className="form-grid"><div className="field"><label htmlFor="peer-name">{t('name')}</label><input id="peer-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Build host" /></div><div className="field"><label htmlFor="peer-url">{t('mobiusUrl')}</label><input id="peer-url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://build.example.com" /></div><button className="primary align-end">{t('addMachine')}</button></div>{error && <p className="form-error">{error}</p>}</form></main>;
}

function PeerRow({ peer, token, onChanged }: { peer: Peer; token: string; onChanged: () => void }) { const { t } = useUi(); const [status, setStatus] = useState<string>(t('check')); const check = async () => { try { const result = await api<Status>(`/api/peers/${peer.id}/status`, token); setStatus(`${result.hostname} ${t('online').toLowerCase()}`); } catch (cause) { setStatus(message(cause)); } }; const remove = async () => { await api(`/api/peers/${peer.id}`, token, { method: 'DELETE' }); onChanged(); }; return <div className="machine-row"><div className="machine-icon remote"><Network size={18} /></div><div><strong>{peer.name}</strong><p>{peer.base_url}</p></div><div className="machine-actions"><span>{status}</span><button className="small-button" onClick={check}>{t('check')}</button><button className="small-button danger" onClick={remove}>{t('remove')}</button></div></div>; }

function FilesPage({ token }: { token: string }) { const { t } = useUi(); const [path, setPath] = useState('/'); const [selected, setSelected] = useState<FileEntry | null>(null); const [content, setContent] = useState(''); const [encoding, setEncoding] = useState('utf8'); const files = useQuery({ queryKey: ['files', path], queryFn: () => api<FileEntry[]>(`/api/files?path=${encodeURIComponent(path)}`, token) }); const open = async (entry: FileEntry) => { if (entry.kind === 'directory') { setPath(entry.path); setSelected(null); return; } setSelected(entry); const read = await api<{ content: string; encoding: string }>(`/api/files/read?path=${encodeURIComponent(entry.path)}`, token); setContent(read.content); setEncoding(read.encoding); }; const save = async () => { if (selected) await api('/api/files/write', token, { method: 'PUT', body: JSON.stringify({ path: selected.path, content, encoding }) }); }; return <main className="page files-page"><div className="page-title"><div><h1>{t('fileTitle')}</h1><p>{t('fileDescription')}</p></div><div className="path-bar"><input value={path} onChange={(event) => setPath(event.target.value)} /><button className="small-button" onClick={() => files.refetch()}>{t('open')}</button></div></div><div className="file-grid"><section className="file-list">{files.isLoading && <div className="empty">Reading {path}…</div>}{files.error && <div className="form-error">{message(files.error)}</div>}{files.data?.map((entry) => <button className={`file-row ${selected?.path === entry.path ? 'selected' : ''}`} onClick={() => open(entry)} key={entry.path}><span>{entry.kind === 'directory' ? 'DIR' : 'FILE'}</span><strong>{entry.name}</strong><small>{entry.kind === 'file' ? `${entry.size.toLocaleString()} B` : ''}</small></button>)}</section><section className="editor">{selected ? <><div className="editor-head"><span>{selected.path} · {encoding}</span><button className="small-button" onClick={save}>{t('save')}</button></div><textarea value={content} onChange={(event) => setContent(event.target.value)} spellCheck={false} /></> : <div className="empty editor-empty"><Files size={24} />{t('chooseFile')}</div>}</section></div></main>; }

function ResourcesPage({ token }: { token: string }) {
  const { t } = useUi();
  const resources = useQuery({ queryKey: ['resources'], queryFn: () => api<Resources>('/api/system/resources', token), refetchInterval: 5_000 });
  const update = useQuery({ queryKey: ['update'], queryFn: () => api<UpdateStatus>('/api/update', token), staleTime: 60_000, retry: false });
  const [restarting, setRestarting] = useState(false);
  const restart = async () => { setRestarting(true); try { await api('/api/update/restart', token, { method: 'POST' }); } catch (cause) { setRestarting(false); } };
  const data = resources.data;
  const metrics = data ? [
    { icon: <Cpu size={18} />, label: t('cpu'), value: percent(data.cpu.usage_percent), detail: `${t('load')}: ${data.cpu.load_1m.toFixed(2)} · ${data.cpu.logical_cpus} cores`, percent: data.cpu.usage_percent },
    { icon: <MemoryStick size={18} />, label: t('memory'), value: `${bytes(data.memory.used_bytes)} / ${bytes(data.memory.total_bytes)}`, detail: `${t('process')}: ${bytes(data.memory.process_used_bytes)} · ${t('otherMemory')}: ${bytes(data.memory.other_used_bytes)} · ${t('available')}: ${bytes(data.memory.available_bytes)}`, percent: data.memory.usage_percent },
    { icon: <Network size={18} />, label: t('network'), value: `${t('received')}: ${rate(data.network.receive_bytes_per_second)} · ${t('transmitted')}: ${rate(data.network.transmit_bytes_per_second)}`, detail: `${t('interfaces')}: ${data.network.interfaces}` },
    { icon: <HardDrive size={18} />, label: t('disk'), value: data.disk ? `${bytes(data.disk.used_bytes)} / ${bytes(data.disk.total_bytes)}` : '—', detail: data.disk ? `${t('available')}: ${bytes(data.disk.available_bytes)} · ${t('mount')}: ${data.disk.mount_point}` : '—', percent: data.disk?.usage_percent },
    { icon: <Database size={18} />, label: t('sqlite'), value: bytes(data.sqlite.total_bytes), detail: `${t('mainFile')}: ${bytes(data.sqlite.main_bytes)} · ${t('walFile')}: ${bytes(data.sqlite.wal_bytes)} · ${t('shmFile')}: ${bytes(data.sqlite.shm_bytes)}`, secondary: `${t('reclaimable')}: ${bytes(data.sqlite.freelist_bytes)} · ${percent(data.sqlite.freelist_percent)}`, percent: data.sqlite.freelist_percent },
  ] : [];
  return <main className="page resources-page"><div className="page-title"><div><h1>{t('resourceTitle')}</h1><p>{t('resourceDescription')}</p></div><button className="small-button refresh" onClick={() => resources.refetch()}><RefreshCw size={14} /> {resources.isFetching ? '…' : '5s'}</button></div>{resources.error && <p className="form-error">{message(resources.error)}</p>}<section className="resource-grid">{data ? metrics.map((metric) => <article className="resource-card" key={metric.label}><div className="resource-icon">{metric.icon}</div><div className="resource-content"><span>{metric.label}</span><strong>{metric.value}</strong><p>{metric.detail}</p>{metric.secondary && <p>{metric.secondary}</p>}{metric.percent !== undefined && <div className="meter"><i style={{ width: `${Math.min(metric.percent, 100)}%` }} /></div>}</div></article>) : Array.from({ length: 5 }).map((_, index) => <article className="resource-card skeleton" key={index} />)}</section><section className="update-panel"><div><span className="machine-label">{t('updateTitle')}</span><h2>{update.data ? `${t('currentVersion')} ${update.data.current_version}` : t('downloading')}</h2><p>{update.data?.detail ?? t('downloading')}</p>{update.error && <p className="form-error">{message(update.error)}</p>}</div>{update.data?.state === 'ready' ? <button className="primary" onClick={restart} disabled={restarting}>{restarting ? <LoaderCircle className="spin" size={16} /> : <RotateCcw size={16} />}{t('restartUpdate')}</button> : <span className="update-state"><Download size={16} /> {update.data?.latest_version ?? '—'}</span>}</section></main>;
}

function SettingsPage({ token }: { token: string }) {
  const { t } = useUi(); const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api<Settings>('/api/settings', token) });
  const [defaultModel, setDefaultModel] = useState(''); const [saving, setSaving] = useState(false); const [notice, setNotice] = useState('');
  useEffect(() => { setDefaultModel(settings.data?.default_model ?? ''); }, [settings.data?.default_model]);
  const save = async (event: FormEvent) => { event.preventDefault(); setSaving(true); setNotice(''); try { const saved = await api<Settings>('/api/settings', token, { method: 'PUT', body: JSON.stringify({ default_model: defaultModel }) }); queryClient.setQueryData(['settings'], saved); setNotice(t('saved')); } catch (cause) { setNotice(message(cause)); } finally { setSaving(false); } };
  return <main className="page settings-page"><div className="page-title"><div><h1>{t('settingsTitle')}</h1><p>{t('settingsDescription')}</p></div></div>{settings.error && <p className="form-error">{message(settings.error)}</p>}<form className="settings-panel" onSubmit={save}><div><h2>{t('modelTitle')}</h2><p>{t('modelDescription')}</p></div><div className="settings-control"><div className="field"><label htmlFor="default-model">{t('modelId')}</label><input id="default-model" value={defaultModel} onChange={(event) => setDefaultModel(event.target.value)} placeholder="gpt-5.6-terra" disabled={settings.isLoading || saving} required /></div><p className="settings-hint">{t('modelIdHint')}</p><div className="settings-actions"><button className="primary" disabled={settings.isLoading || saving}>{saving ? <LoaderCircle className="spin" size={16} /> : null}{t('saveChanges')}</button>{notice && <span className={notice === t('saved') ? 'settings-saved' : 'form-error'}>{notice}</span>}</div></div></form></main>;
}

function bytes(value: number) { const units = ['B', 'KB', 'MB', 'GB', 'TB']; let index = 0; let size = value; while (size >= 1024 && index < units.length - 1) { size /= 1024; index++; } return `${size >= 10 || index === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[index]}`; }
function rate(value: number) { return `${bytes(value)}/s`; }
function percent(value: number) { return `${value.toFixed(1)}%`; }

function Center({ children }: { children: ReactNode }) { return <main className="center">{children}</main>; }
function message(cause: unknown) { return cause instanceof Error ? cause.message : 'Something went wrong.'; }

function normalizedAuthUrl(authUrl: string) { const url = new URL(authUrl.trim()); url.search = ''; url.hash = ''; url.pathname = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`; return url.toString(); }

function beginAuthRedirect(authUrl: string) {
  const normalized = normalizedAuthUrl(authUrl); const state = crypto.randomUUID();
  sessionStorage.setItem('mobius.auth_url', normalized); sessionStorage.setItem('mobius.login_state', state);
  const callback = `${location.origin}${location.pathname}#/auth/callback`; const params = new URLSearchParams({ redirect_uri: callback, state });
  if (location.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) params.set('aud', location.hostname);
  location.assign(`${normalized}web/#/login?${params.toString()}`);
}

function acceptRedirectSession(): string | null {
  if (!location.hash.startsWith('#/auth/callback?')) return null;
  const params = new URLSearchParams(location.hash.slice('#/auth/callback?'.length)); const expectedState = sessionStorage.getItem('mobius.login_state'); const authUrl = sessionStorage.getItem('mobius.auth_url');
  if (!authUrl || !expectedState || params.get('state') !== expectedState) return null;
  const accessToken = params.get('access_token'); const sessionId = params.get('session_id'); const refreshToken = params.get('refresh_token'); const expiresIn = Number(params.get('expires_in'));
  if (!accessToken || !sessionId || !refreshToken || !Number.isFinite(expiresIn)) return null;
  const receivedAt = new Date(); localStorage.setItem(`auth-mini.sdk:${normalizedAuthUrl(authUrl)}`, JSON.stringify({ accessToken, sessionId, refreshToken, receivedAt: receivedAt.toISOString(), expiresAt: new Date(receivedAt.getTime() + expiresIn * 1000).toISOString() }));
  sessionStorage.removeItem('mobius.login_state'); history.replaceState(null, '', `${location.pathname}${location.search}#/console`); return authUrl;
}

createRoot(document.getElementById('root')!).render(<QueryClientProvider client={queryClient}><UiProvider><HashRouter><App /></HashRouter></UiProvider></QueryClientProvider>);
