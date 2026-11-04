window.__ModuleLoader__.load({
	id: '@dsh-friends/model-catalog',
	factory: (require) => {
		const React = require('react');
		const h = React.createElement;
		const API_CHOICES = [
			['openai-completions', 'OpenAI Completions'],
			['openai-responses', 'OpenAI Responses'],
			['anthropic-messages', 'Anthropic Messages'],
		];
		const REASONING_VALUES = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
		const STYLE_ID = 'dsh-model-catalog-style';
		const css = `
.mc-root{color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:13px;width:100%;min-width:0;margin:0 auto;--mc-line:var(--dsw-alias-settings-card-stroke,rgba(127,140,155,.24));--mc-muted:var(--dsw-alias-label-tertiary,#858b93);--mc-bg:var(--dsw-alias-settings-card-fill,rgba(127,140,155,.05));--mc-input:var(--dsw-alias-settings-input-fill,transparent);--mc-accent:var(--dsw-alias-state-active-primary,#6ea8fe)}
.mc-root *{box-sizing:border-box}.mc-root button,.mc-root input,.mc-root select,.mc-root textarea{font:inherit}.mc-head,.mc-topline{display:flex;align-items:center;justify-content:space-between;gap:12px}.mc-head{margin-bottom:16px}.mc-head h2{font-size:18px;font-weight:600;margin:0}.mc-head p{margin:5px 0 0}.mc-actions{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.mc-panel{border:1px solid var(--mc-line);border-radius:8px;margin:12px 0;background:var(--mc-bg);min-width:0}.mc-provider{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:12px;padding:14px 16px}.mc-provider-name{display:flex;align-items:center;gap:8px;min-width:0}.mc-provider-name strong{font-weight:600;overflow-wrap:anywhere}.mc-provider .mc-actions{flex-wrap:nowrap}.mc-model{transition:opacity .12s ease,border-color .12s ease}.mc-model[draggable=true]{cursor:grab}.mc-model[draggable=true]:active{cursor:grabbing}.mc-model.mc-dragging{opacity:.45}.mc-drag-handle{width:26px;height:30px;padding:0;border:0;background:transparent;color:var(--mc-muted);font-size:17px;cursor:grab;touch-action:none}.mc-drag-handle:disabled{opacity:.35;cursor:default}.mc-priority{margin-left:auto;flex:none}.mc-order{min-width:38px;text-align:right;font-variant-numeric:tabular-nums;color:var(--mc-muted);font-size:11px}.mc-meta,.mc-note{font-size:12px;color:var(--mc-muted);line-height:1.6;overflow-wrap:anywhere}.mc-provider .mc-meta{margin-top:4px}.mc-badge{display:inline-flex;flex:none;font-size:11px;line-height:1.5;padding:1px 6px;border:1px solid var(--mc-line);border-radius:4px;color:var(--mc-muted);white-space:nowrap}.mc-badge.dirty{color:var(--mc-accent);border-color:var(--mc-accent)}.mc-btn{border:1px solid var(--mc-line);border-radius:5px;background:var(--mc-input);color:inherit;min-height:30px;padding:5px 10px;line-height:1.4;cursor:pointer;white-space:nowrap}.mc-btn:hover:not(:disabled){background:var(--mc-bg)}.mc-btn.primary{background:var(--mc-accent);border-color:var(--mc-accent);color:var(--dsw-alias-label-on-color,#10141a)}.mc-btn.danger{color:var(--dsw-alias-state-danger-primary,#cd6565)}.mc-btn:disabled{opacity:.45;cursor:default}.mc-root :is(button,input,select,textarea,summary):focus-visible{outline:2px solid var(--mc-accent);outline-offset:2px}.mc-editor{padding:16px;scroll-margin-top:20px}.mc-editor h3,.mc-models-heading{font-size:14px;font-weight:600;margin:0}.mc-editor .mc-topline{margin-bottom:14px}.mc-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 16px}.mc-field{display:flex;flex-direction:column;gap:5px;min-width:0}.mc-field>label{font-size:12px;color:var(--mc-muted)}.mc-field :is(input,select,textarea){width:100%;min-width:0;max-width:100%;border:1px solid var(--mc-line);border-radius:5px;background:var(--mc-input);color:inherit;padding:7px 9px;line-height:1.5}.mc-field textarea{resize:vertical;min-height:90px;font-family:monospace;font-size:12px}.mc-check{display:flex;align-items:center;gap:7px;min-height:30px;cursor:pointer}.mc-check input,.mc-enable{margin:0;accent-color:var(--mc-accent);flex:none}.mc-check input{width:auto}.mc-footer{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:14px}.mc-details{margin-top:12px;min-width:0}.mc-details summary{cursor:pointer;color:var(--mc-muted);font-size:12px}.mc-sub{margin-top:10px}.mc-wide{grid-column:1 / -1}.mc-models{border-top:1px solid var(--mc-line);padding:0 16px 4px}.mc-models-top{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 0 8px}.mc-model{border-top:1px solid var(--mc-line);min-width:0}.mc-model:first-child{border-top:0}.mc-model-row{display:flex;align-items:center;gap:8px;padding:4px 0;min-width:0}.mc-model-title{display:flex;align-items:center;gap:8px;flex:0 1 auto;max-width:min(68%,560px);min-width:0;white-space:nowrap;flex-wrap:nowrap}.mc-model-title>.mc-model-name,.mc-model-title>.mc-model-id,.mc-model-title>.mc-model-labels{display:inline-flex;align-items:center;flex:none}.mc-model-name{line-height:1.35}.mc-model-id{line-height:1.35}.mc-model-labels{display:flex;gap:4px;flex-wrap:nowrap;margin-top:0}.mc-model-labels .mc-badge{line-height:1.3;padding:0 5px}.mc-order{white-space:nowrap}.mc-model-row .mc-btn{min-height:28px;padding:4px 9px}.mc-model-title{min-width:0}.mc-model-name{font-weight:500;overflow-wrap:anywhere;line-height:1.35}.mc-model-id{font-size:11px;color:var(--mc-muted);overflow-wrap:anywhere;line-height:1.35}.mc-model-labels{display:flex;align-items:center;gap:4px;flex-wrap:nowrap;margin-top:0}.mc-priority{color:var(--mc-muted);font-size:11px;white-space:nowrap}.mc-model-editor{padding:4px 0 14px;min-width:0}.mc-model-editor>.mc-note{margin:0 0 12px}.mc-error,.mc-success,.mc-loading{padding:10px 12px;border:1px solid var(--mc-line);border-radius:6px;margin:10px 0;font-size:12px;line-height:1.6;overflow-wrap:anywhere}.mc-error{color:var(--dsw-alias-state-danger-primary,#cd6565);border-color:currentColor}.mc-success{color:var(--dsw-alias-label-secondary,inherit);background:var(--mc-bg)}.mc-loading{color:var(--mc-muted)}.mc-empty{padding:24px 12px;text-align:center;color:var(--mc-muted);line-height:1.7}
@media(max-width:520px){.mc-model-title{max-width:calc(100% - 90px);flex-wrap:wrap}.mc-model-labels{flex-wrap:wrap}.mc-head{align-items:flex-start;flex-wrap:wrap}.mc-form{grid-template-columns:minmax(0,1fr)}.mc-provider{grid-template-columns:minmax(0,1fr);gap:10px;padding:12px}.mc-provider .mc-actions{justify-content:flex-end}.mc-provider-name{flex-wrap:wrap}.mc-editor{padding:12px}.mc-models{padding-left:12px;padding-right:12px}.mc-model-row{gap:8px;grid-template-columns:20px 16px minmax(0,1fr) auto}.mc-priority{grid-column:3;grid-row:2}.mc-model-row>.mc-btn{grid-column:4;grid-row:1 / span 2}.mc-model-row{row-gap:2px}.mc-model-labels{gap:4px}}
`;
		function installStyle() {
			let style = document.getElementById(STYLE_ID);
			if (!style) {
				style = document.createElement('style');
				style.id = STYLE_ID;
				document.head.appendChild(style);
			}
			style.textContent = css;
		}
		function apiUrl() { return new URL('api/model-catalog/state', location.href); }
		function errorText(error) { return String(error?.message || error || '请求失败'); }
		function Field({ label, id, children }) { return h('div', { className: 'mc-field' }, h('label', { htmlFor: id }, label), children); }
		function Button({ children, className = '', ...props }) { return h('button', { type: 'button', className: `mc-btn ${className}`, ...props }, children); }
		function modelKey(providerId, modelId) { return JSON.stringify([providerId, modelId]); }
		function draftValues(row) {
			const value = { ...row.raw, ...row.effective, ...row.override };
			return {
				enabled: value.enabled !== false,
				name: value.name ?? '',
				contextWindow: String(value.contextWindow ?? ''), maxTokens: String(value.maxTokens ?? ''),
				image: Array.isArray(value.input) && value.input.includes('image'),
				reasoningEfforts: value.reasoningEfforts === false ? '不支持' : Array.isArray(value.reasoningEfforts) ? value.reasoningEfforts.join(', ') : '',
				compat: value.compat ? JSON.stringify(value.compat, null, 2) : '',
			};
		}
		function createDraft(row) {
			const values = draftValues(row);
			return { values, original: { ...values }, error: '' };
		}
		function isDirty(draft) { return Object.keys(draft.values).some((key) => draft.values[key] !== draft.original[key]); }
		function modelPatch(draft, row) {
			const patch = {};
			for (const [key, value] of Object.entries(draft.values)) {
				if (value === draft.original[key]) continue;
				if (key === 'name') patch.name = value.trim() || undefined;
				else if (['contextWindow', 'maxTokens'].includes(key)) {
					const number = value.trim() === '' ? undefined : Number(value);
					if (number !== undefined && (!Number.isInteger(number) || number <= 0)) throw new Error('上下文与最大输出必须是正整数，或留空使用目录值。');
					patch[key] = number;
				} else if (key === 'image') {
					const input = row.override.input ?? row.effective.input ?? row.raw.input ?? ['text'];
					patch.input = [...new Set([...input.filter((item) => item !== 'image'), ...(value ? ['image'] : [])])];
				} else if (key === 'reasoningEfforts') {
					const text = value.trim();
					const efforts = [...new Set(text.split(/[,，]/).map((item) => item.trim()).filter(Boolean))];
					if (text && text !== '不支持' && efforts.some((item) => !REASONING_VALUES.includes(item))) throw new Error(`推理等级可填 ${REASONING_VALUES.join(', ')}，或“不支持”。`);
					patch.reasoningEfforts = text === '不支持' ? false : text ? efforts : undefined;
				} else if (key === 'compat') {
					if (!value.trim()) { patch.compat = undefined; continue; }
					let parsed;
					try { parsed = JSON.parse(value); } catch { throw new Error('兼容参数必须是有效 JSON 对象。'); }
					if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).some((item) => ['__proto__', 'prototype', 'constructor'].includes(item))) throw new Error('兼容参数必须是 JSON 对象，且不能包含不安全的键。');
					patch.compat = parsed;
				} else patch[key] = value;
			}
			return patch;
		}

		function App() {
			const [snapshot, setSnapshot] = React.useState(null);
			const [busy, setBusy] = React.useState(false);
			const [error, setError] = React.useState('');
			const [success, setSuccess] = React.useState('');
			const [editing, setEditing] = React.useState(null);
			const [form, setForm] = React.useState(null);
			const [drafts, setDrafts] = React.useState({});
			const [dragging, setDragging] = React.useState(null);
			const editorRef = React.useRef(null);
			const pendingRef = React.useRef(false);
			const hasDrafts = Object.keys(drafts).length > 0;
			const load = React.useCallback(async () => {
				if (pendingRef.current) return;
				pendingRef.current = true;
				setBusy(true); setError(''); setSuccess('');
				try {
					const response = await fetch(apiUrl(), { credentials: 'same-origin', headers: { Accept: 'application/json' } });
					const body = await response.json();
					if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
					setSnapshot(body);
				} catch (e) { setError(errorText(e)); }
				finally { pendingRef.current = false; setBusy(false); }
			}, []);
			React.useEffect(() => { installStyle(); load(); }, [load]);
			React.useEffect(() => {
				if (!editing || !editorRef.current) return;
				editorRef.current.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
				editorRef.current.querySelector?.('input:not(:disabled)')?.focus({ preventScroll: true });
			}, [editing]);
			const post = async (payload, message) => {
				if (pendingRef.current) return null;
				pendingRef.current = true;
				setBusy(true); setError(''); setSuccess('');
				try {
					const response = await fetch(apiUrl(), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(payload) });
					const body = await response.json();
					if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
					setSnapshot(body); setSuccess(message || '已保存。');
					return body;
				} catch (e) {
					const message = errorText(e);
					setError(message);
					if (/stale|revision|conflict|配置已|同步期间/i.test(message)) {
						try {
							const latest = await fetch(apiUrl(), { credentials: 'same-origin', headers: { Accept: 'application/json' } });
							const current = await latest.json();
							if (latest.ok) setSnapshot(current);
						} catch {}
					}
					return null;
				} finally { pendingRef.current = false; setBusy(false); }
			};
			const clearMessages = () => { setError(''); setSuccess(''); };
			const closeProvider = () => { setEditing(null); setForm(null); };
			const startNew = () => { clearMessages(); setEditing('__new__'); setForm({ id: '', displayName: '', baseURL: '', api: 'openai-completions', catalogURL: '', refreshIntervalSeconds: 300, enabled: true, apiKey: '' }); };
			const startEdit = (p) => { clearMessages(); setEditing(p.id); setForm({ id: p.id, displayName: p.displayName, baseURL: p.baseURL || '', api: p.api, catalogURL: p.catalogURL || '', refreshIntervalSeconds: p.refreshIntervalSeconds ?? 300, enabled: p.enabled !== false, hasApiKey: p.hasApiKey, apiKey: '' }); };
			const setField = (key, value) => setForm((old) => ({ ...old, [key]: value }));
			const saveProvider = async (sync = false) => {
				const old = editing === '__new__' ? null : snapshot.providers.find((p) => p.id === editing);
				const provider = { id: String(form.id || '').trim(), displayName: String(form.displayName || '').trim(), baseURL: String(form.baseURL || '').trim(), api: form.api, refreshIntervalSeconds: form.refreshIntervalSeconds === '' ? 300 : Number(form.refreshIntervalSeconds), enabled: Boolean(form.enabled), overrides: old?.overrides || {} };
				if (String(form.catalogURL || '').trim()) provider.catalogURL = String(form.catalogURL).trim();
				if (!Number.isFinite(provider.refreshIntervalSeconds) || provider.refreshIntervalSeconds < 0) { setError('自动同步间隔必须是大于或等于 0 的数字。'); return; }
				const result = await post({ op: 'save', revision: snapshot.revision, provider, ...(form.apiKey ? { apiKey: form.apiKey } : {}) }, '服务已保存。');
				if (result) {
					closeProvider();
					if (sync) await post({ op: 'sync', id: provider.id, revision: result.revision }, '服务已保存并同步。');
				}
			};
			const modelRows = (provider) => {
				const rawModels = snapshot.catalogs?.[provider.id]?.models || [];
				const effective = snapshot.effective?.[provider.id] || [];
				const overrides = provider.overrides || {};
				// 模型行完全跟随上游目录：override-only 条目不显示（上游没有了就是无效的；disabled 模型仍经 raw 行展示）
				// 排序基准与服务端一致：override.priority 优先，否则 effective/raw 数组位置（跟随上游同步换序）。
				const rawPos = new Map(rawModels.map((m, i) => [m.id, i]));
				const effPos = new Map(effective.map((m, i) => [m.id, i]));
				const orderKey = (row) => {
					if (Number.isFinite(row.override.priority)) return row.override.priority;
					const pos = effPos.has(row.id) ? effPos.get(row.id) : rawPos.get(row.id);
					return Number.isFinite(pos) ? pos : 1000;
				};
				const ids = new Set([...rawModels.map((m) => m.id), ...effective.map((m) => m.id)]);
				return [...ids].map((id) => ({ id, raw: rawModels.find((m) => m.id === id) || {}, effective: effective.find((m) => m.id === id) || {}, override: overrides[id] || {} }))
					.sort((a, b) => (orderKey(a) - orderKey(b)) || a.id.localeCompare(b.id));
			};
			const discardDraft = (key) => setDrafts((old) => { const next = { ...old }; delete next[key]; return next; });
			const changeModel = (provider, row, field, value) => {
				clearMessages();
				const key = modelKey(provider.id, row.id);
				setDrafts((old) => {
					const draft = old[key] || createDraft(row);
					return { ...old, [key]: { ...draft, error: '', values: { ...draft.values, [field]: value } } };
				});
			};
			const persistOrder = async (provider, orderedRows) => {
				const overrides = { ...(provider.overrides || {}) };
				const rawOrder = new Map((snapshot.catalogs?.[provider.id]?.models || []).map((m, i) => [m.id, i]));
				orderedRows.forEach((row, index) => {
					const current = { ...(overrides[row.id] || {}) };
					// 与上游数组下标(0-based)对齐:行保持上游原位时不写 priority,让顺序跟随上游同步;
					// 不在上游的行(已下线残留)没有原位,显式写位置。
					const rawIndex = rawOrder.get(row.id);
					if (rawIndex === index) delete current.priority; else current.priority = index;
					if (Object.keys(current).length) overrides[row.id] = current; else delete overrides[row.id];
				});
				const result = await post({ op: 'save', revision: snapshot.revision, provider: { ...provider, overrides } }, '模型顺序已保存。');
				if (!result) { setError('排序保存失败，请刷新目录状态后重试。'); return false; }
				return true;
			};
			const reorderRows = async (provider, from, to) => {
				if (from === to || from < 0 || to < 0) return;
				const rows = modelRows(provider);
				const moved = rows.splice(from, 1)[0];
				rows.splice(to, 0, moved);
				await persistOrder(provider, rows);
			};
			const saveModel = async (provider, row, reset = false) => {
				const key = modelKey(provider.id, row.id);
				const draft = drafts[key];
				let patch;
				try { patch = reset ? {} : modelPatch(draft, row); }
				catch (e) { setDrafts((old) => ({ ...old, [key]: { ...old[key], error: errorText(e) } })); return; }
				const overrides = { ...(provider.overrides || {}) };
				const current = { ...(overrides[row.id] || {}) };
				if (reset) delete overrides[row.id];
				else {
					for (const [field, value] of Object.entries(patch)) value === undefined ? delete current[field] : current[field] = value;
					if (Object.keys(current).length) overrides[row.id] = current; else delete overrides[row.id];
				}
				const result = await post({ op: 'save', revision: snapshot.revision, provider: { ...provider, overrides } }, `${row.id} ${reset ? '已重置为目录参数' : '覆盖已保存'}。`);
				if (result) discardDraft(key);
				else setDrafts((old) => ({ ...old, [key]: { ...old[key], error: '提交失败，草稿已保留。请查看页面上方的错误提示后重试。' } }));
			};
			const rowsView = (provider) => {
				const rows = modelRows(provider);
				if (!rows.length) return h('div', { className: 'mc-empty' }, '暂无模型。点击“同步”获取目录。');
				return h('div', null, ...rows.map((row, index) => {
					const key = modelKey(provider.id, row.id);
					const draft = drafts[key];
					const value = draft?.values || draftValues(row);
					const overridden = Object.keys(row.override).some((field) => field !== 'priority');
					const dirty = draft && isDirty(draft);
					const fieldId = `mc-model-${encodeURIComponent(provider.id)}-${index}`;
					const field = (name, label, props = {}) => h(Field, { label, id: `${fieldId}-${name}` }, h('input', { id: `${fieldId}-${name}`, type: 'text', value: value[name], disabled: busy, 'aria-label': `${row.id} ${label}`, onChange: (e) => changeModel(provider, row, name, e.target.value), ...props }));
					return h('article', { className: `mc-model${dragging === index ? ' mc-dragging' : ''}`, key,
							draggable: false,
							onDragOver: (event) => { if (dragging !== null) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } },
							onDrop: async (event) => { event.preventDefault(); const id = event.dataTransfer.getData('text/plain'); const from = rows.findIndex(item => item.id === id); setDragging(null); await reorderRows(provider, from, index); },
							onDragEnd: () => setDragging(null) },
						h('div', { className: 'mc-model-row' },
							h('button', { type: 'button', className: 'mc-drag-handle', disabled: busy || Boolean(editing) || hasDrafts, 'aria-label': `拖动 ${row.id} 调整顺序`, title: '拖动调整顺序',
									ref: (element) => { if (element) element.draggable = true; },
									onDragStart: (event) => { setDragging(index); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', row.id); },
									onDragEnd: () => setDragging(null),
									onKeyDown: async (event) => { if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return; event.preventDefault(); await reorderRows(provider, index, Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1)))); },
									onDragOver: (event) => { if (dragging !== null) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } },
									onDrop: async (event) => { event.preventDefault(); const id = event.dataTransfer.getData('text/plain'); const from = rows.findIndex(item => item.id === id); setDragging(null); await reorderRows(provider, from, index); } }, '⠿'),
							h('input', { className: 'mc-enable', type: 'checkbox', checked: value.enabled, disabled: busy || Boolean(editing), 'aria-label': `启用 ${row.id}`, onChange: (e) => changeModel(provider, row, 'enabled', e.target.checked) }),
							h('div', { className: 'mc-model-title' }, h('div', { className: 'mc-model-name' }, value.name || row.id), h('div', { className: 'mc-model-id' }, row.id), (dirty || overridden || !Object.keys(row.raw).length) && h('div', { className: 'mc-model-labels' }, dirty && h('span', { className: 'mc-badge dirty' }, '未保存'), overridden && h('span', { className: 'mc-badge' }, '已覆盖'), !Object.keys(row.raw).length && h('span', { className: 'mc-badge' }, '自定义记录'))),
							h('span', { className: 'mc-priority' }, `${index + 1} / ${rows.length}`),
							h(Button, { disabled: busy || Boolean(editing), 'aria-expanded': Boolean(draft), 'aria-controls': `${fieldId}-editor`, 'aria-label': `${row.id} 参数`, onClick: () => { if (draft) discardDraft(key); else { clearMessages(); setDrafts((old) => ({ ...old, [key]: createDraft(row) })); } } }, draft ? '取消' : '参数')),
						draft && h('div', { className: 'mc-model-editor', id: `${fieldId}-editor` },
							h('p', { className: 'mc-note' }, '修改仅保存在本地草稿，点击“保存覆盖”后生效。字段留空恢复目录值。'),
							draft.error && h('div', { className: 'mc-error', role: 'alert' }, draft.error),
							h('div', { className: 'mc-form' },
								field('name', '显示名称'),
								field('contextWindow', '上下文', { type: 'number', min: '1', step: '1' }), field('maxTokens', '最大输出', { type: 'number', min: '1', step: '1' }),
								field('reasoningEfforts', '推理等级', { placeholder: '例如 low, medium, high；不支持填“不支持”' }),
								h('label', { className: 'mc-check' }, h('input', { type: 'checkbox', checked: value.image, disabled: busy, 'aria-label': `${row.id} 支持图像`, onChange: (e) => changeModel(provider, row, 'image', e.target.checked) }), '支持图像'),
								h('details', { className: 'mc-details mc-wide' }, h('summary', null, '兼容参数（JSON，可选）'), h('div', { className: 'mc-sub' }, h(Field, { label: 'compat JSON', id: `${fieldId}-compat` }, h('textarea', { id: `${fieldId}-compat`, value: value.compat, disabled: busy, 'aria-label': `${row.id} compat JSON`, spellCheck: false, placeholder: '{}', onChange: (e) => changeModel(provider, row, 'compat', e.target.value) }))))),
							h('div', { className: 'mc-footer' }, h(Button, { className: 'primary', disabled: busy || !dirty, onClick: () => saveModel(provider, row) }, '保存覆盖'), h(Button, { disabled: busy || !overridden, onClick: () => saveModel(provider, row, true) }, '重置'), h(Button, { disabled: busy, onClick: () => discardDraft(key) }, '取消'), h('span', { className: 'mc-note' }, '重置将移除此模型的全部覆盖。'))));
				}));
			};
			const providerField = (name, label, props = {}) => h(Field, { label, id: `mc-provider-${name}` }, h('input', { id: `mc-provider-${name}`, value: form[name] ?? '', disabled: busy, 'aria-label': label, onChange: (e) => setField(name, e.target.value), ...props }));
			const renderEditor = () => h('section', { className: 'mc-panel mc-editor', ref: editorRef, 'aria-labelledby': 'mc-provider-editor-title' },
				h('div', { className: 'mc-topline' }, h('h3', { id: 'mc-provider-editor-title' }, editing === '__new__' ? '添加服务' : `编辑服务 · ${form.displayName || form.id}`), h(Button, { disabled: busy, onClick: closeProvider }, '取消')),
				h('div', { className: 'mc-form' },
					providerField('id', '服务 ID', { disabled: editing !== '__new__' || busy, placeholder: '例如 openrouter' }),
					providerField('displayName', 'DSH 显示名称'),
					providerField('baseURL', '服务地址', { placeholder: 'https://api.example.com/v1' }),
					h(Field, { label: '请求格式', id: 'mc-provider-api' }, h('select', { id: 'mc-provider-api', 'aria-label': '请求格式', value: form.api, disabled: busy, onChange: (e) => setField('api', e.target.value) }, ...API_CHOICES.map(([value, label]) => h('option', { key: value, value }, label)))),
					providerField('apiKey', 'API Key', { type: 'password', autoComplete: 'new-password', placeholder: form.hasApiKey ? '留空保留现有密钥' : '输入 API Key' }),
					providerField('refreshIntervalSeconds', '自动同步间隔（秒，0 关闭）', { type: 'number', min: '0' }),
					h('label', { className: 'mc-check' }, h('input', { type: 'checkbox', checked: Boolean(form.enabled), disabled: busy, onChange: (e) => setField('enabled', e.target.checked) }), '启用服务'),
					h('details', { className: 'mc-details mc-wide' }, h('summary', null, '高级设置'), h('div', { className: 'mc-sub' }, providerField('catalogURL', '目录 URL（留空使用默认路径）', { placeholder: 'https://api.example.com/models' })))),
				h('div', { className: 'mc-footer' },
					h(Button, { className: 'primary', disabled: busy || !form.id?.trim() || !form.displayName?.trim(), onClick: () => saveProvider() }, '保存'),
					h(Button, { disabled: busy || !form.id?.trim() || !form.displayName?.trim(), onClick: () => saveProvider(true) }, '保存并同步'),
					h('span', { className: 'mc-note' }, form.hasApiKey ? 'API Key 留空保留现有密钥。' : '密钥仅用于服务请求。')));

			if (!snapshot) return h('div', { className: 'mc-root', 'aria-busy': busy }, h('div', { className: 'mc-head' }, h('h2', null, '模型目录'), h(Button, { onClick: load, disabled: busy }, busy ? '加载中…' : '重试')), error && h('div', { className: 'mc-error', role: 'alert' }, error), busy && h('div', { className: 'mc-loading', role: 'status' }, '正在加载服务与模型目录…'));
			return h('main', { className: 'mc-root', 'aria-busy': busy },
				h('div', { className: 'mc-head' }, h('div', null, h('h2', null, '模型目录'), h('p', { className: 'mc-note' }, '管理服务与模型参数覆盖')), h('div', { className: 'mc-actions' }, h(Button, { onClick: load, disabled: busy || Boolean(editing) || hasDrafts, title: editing || hasDrafts ? '请先保存或取消编辑' : '刷新目录状态' }, '刷新'), h(Button, { className: 'primary', onClick: startNew, disabled: busy || Boolean(editing) || hasDrafts }, '添加服务'))),
				error && h('div', { className: 'mc-error', role: 'alert' }, error),
				success && h('div', { className: 'mc-success', role: 'status' }, success),
				busy && h('div', { className: 'mc-loading', role: 'status' }, '正在处理，请稍候…'),
				editing && form && renderEditor(),
				snapshot.providers?.length ? snapshot.providers.map((provider) => {
					const catalog = snapshot.catalogs?.[provider.id] || {};
					const count = snapshot.effective?.[provider.id]?.length || 0;
					const locked = busy || Boolean(editing) || hasDrafts;
					return h('section', { className: 'mc-panel', key: provider.id },
						h('div', { className: 'mc-provider' }, h('div', null, h('div', { className: 'mc-provider-name' }, h('strong', null, provider.displayName || provider.id), h('span', { className: 'mc-badge' }, provider.enabled !== false ? '已启用' : '已停用')), h('div', { className: 'mc-meta' }, `${provider.id} · ${provider.api} · ${count} 个生效模型`), catalog.syncedAt && h('div', { className: 'mc-meta' }, `同步于 ${new Date(catalog.syncedAt).toLocaleString()}`)), h('div', { className: 'mc-actions' },
							h(Button, { disabled: locked, onClick: () => post({ op: 'sync', id: provider.id, revision: snapshot.revision }, '目录已同步。') }, '同步'),
							h(Button, { disabled: locked, onClick: () => startEdit(provider) }, '编辑'),
							h(Button, { className: 'danger', disabled: locked, onClick: () => { if (window.confirm(`移除服务“${provider.displayName || provider.id}”？`)) post({ op: 'remove', id: provider.id, revision: snapshot.revision }, '服务已移除。'); } }, '移除'))),
						catalog.error && h('div', { className: 'mc-error', role: 'status', style: { margin: '0 16px 12px' } }, catalog.error),
						h('div', { className: 'mc-models' }, h('div', { className: 'mc-models-top' }, h('h3', { className: 'mc-models-heading' }, '模型'), h('span', { className: 'mc-meta' }, `${modelRows(provider).length} 条记录`)), rowsView(provider)));
				}) : h('div', { className: 'mc-empty' }, '尚未配置服务。点击“添加服务”开始。'));
		}
		return {
			inject: ['slots'],
			apply(ctx) {
				ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'model-catalog', order: 11, label: () => '模型目录' }, App));
			},
		};
	},
});
