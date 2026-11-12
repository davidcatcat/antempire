/**
 * SAVE-2 main menu of the V6-2 experiment mode: 【繼續遊戲】【開始新遊戲】【讀取存檔】【存檔管理】, the save list,
 * rename, two-step delete (in-page, never window.confirm), export / import / import as copy, storage status.
 * Everything shown is NON-OFFICIAL experiment worlds stored in this browser only (no sync, no official data).
 * The menu never runs or changes a world; it calls the session (Worker + store) and the page's enter/leave hooks.
 */
import { ExperimentSaveStore, type WorldListing } from './experimental/save-store.ts';
import { MAX_IMPORT_BYTES, simDayTime } from './experimental/save-format.ts';
import type { ExperimentSession } from './experimental/session.ts';
import type { RuntimeInfo } from './experimental/save-format.ts';
import type { WorldKind } from './experimental/worker-protocol.ts';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const when = (iso: string | null) => iso ? new Date(iso).toLocaleString('zh-TW', { hour12: false }) : '—';
const kb = (n: number) => n >= 1048576 ? `${(n / 1048576).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} KB`;
const simTime = (t: number | null) => { const d = simDayTime(t); return d ? `實驗第 ${d.day} 天 ${d.clock}` : '—'; };
const COMPAT: Record<string, string> = { compatible: '相容', migratable: '可遷移（舊版結構）', no_snapshot: '沒有已驗證的存檔', newer_schema: '存檔來自較新版本，無法讀取', unknown_schema: '未知格式，無法讀取', rules_mismatch: '規則不同，無法繼續', no_migration_path: '沒有遷移路徑，無法讀取' };
export const loadable = (w: WorldListing) => w.compat === 'compatible' || w.compat === 'migratable';
function versionDiff(w: WorldListing, rt: { rules_fingerprint: string; engine_version: string }) {
  return `存檔：規則指紋 ${esc(w.rules_fingerprint.slice(0, 12))}…、引擎 ${esc(w.engine_version)}、結構 v${w.schema_version}；目前：規則指紋 ${esc(rt.rules_fingerprint.slice(0, 12))}…、引擎 ${esc(rt.engine_version)}`;
}
function individuals(w: WorldListing) {
  const s = w.summary ?? {};
  if (s.workers !== null && s.workers !== undefined) return `工蟻 ${s.workers}${s.larvae !== null && s.larvae !== undefined ? `、幼蟲 ${s.larvae}` : ''}（${esc(s.note ?? '')}）`;
  if (s.individuals !== null && s.individuals !== undefined) return `個體 ${s.individuals}（${esc(s.note ?? '合成世界沒有蟻后')}）`;
  return `蟻后 ${w.queens ?? '—'}、工蟻 ${w.workers ?? '—'}`;
}

export interface MenuHooks { enter: (how: string) => void; message: (html: string, kind?: 'info' | 'warn' | 'error') => void }

export class Menu {
  private readonly root: HTMLElement; private readonly panel: HTMLElement; private readonly msgEl: HTMLElement;
  private readonly session: ExperimentSession | null; private readonly hooks: MenuHooks;
  private view: 'home' | 'new' | 'load' | 'manage' = 'home';
  private pendingDelete: { world_id: string; nonce: string; name: string } | null = null;
  private pendingCopyText: string | null = null;
  constructor(root: HTMLElement, session: ExperimentSession | null, hooks: MenuHooks) {
    this.root = root; this.session = session; this.hooks = hooks;
    this.panel = root.querySelector('#mPanel') as HTMLElement; this.msgEl = root.querySelector('#mMsg') as HTMLElement;
    (root.querySelector('#mContinue') as HTMLButtonElement).onclick = () => void this.continueLast();
    (root.querySelector('#mNew') as HTMLButtonElement).onclick = () => { this.view = 'new'; void this.render(); };
    (root.querySelector('#mLoad') as HTMLButtonElement).onclick = () => { this.view = 'load'; void this.render(); };
    (root.querySelector('#mManage') as HTMLButtonElement).onclick = () => { this.view = 'manage'; void this.render(); };
    root.addEventListener('click', (e) => void this.onClick(e));
  }
  show(msg?: string, kind: 'info' | 'warn' | 'error' = 'info') { this.root.hidden = false; this.view = 'home'; if (msg) this.say(msg, kind); else this.say(''); void this.render(); void this.storageStatus(); }
  hide() { this.root.hidden = true; }
  say(html: string, kind: 'info' | 'warn' | 'error' = 'info') { this.msgEl.innerHTML = html; this.msgEl.dataset.kind = kind; }

  private async storageStatus() {
    const el = this.root.querySelector('#mStorage') as HTMLElement;
    if (!this.session) { el.textContent = '此瀏覽器無法使用本地儲存（例如私密模式或封鎖網站資料）：無法存檔。'; return; }
    const p = await ExperimentSaveStore.requestPersistence();
    const mb = (n: number | null) => n === null ? '—' : `${(n / 1048576).toFixed(1)} MB`;
    el.innerHTML = `持久儲存：${!p.supported ? '此瀏覽器不支援請求' : p.persisted ? '<b>已獲准</b>' : '<b>未獲准</b>'}｜已用 ${mb(p.usage)}／配額 ${mb(p.quota)}<br><span class="muted">存檔只在這個瀏覽器（不跨裝置同步）。即使已獲准，清除網站資料、私密模式或瀏覽器回收空間仍可能讓存檔消失，請用「存檔管理 → 匯出」保存備份。</span>`;
    el.dataset.persisted = String(p.persisted);
  }

  private async continueLast() {
    if (!this.session) return;
    const id = await this.session.store.lastPlayed();
    if (!id) { this.say('還沒有存檔。請「開始新遊戲」。', 'warn'); return; }
    await this.openWorld(id, {});
  }
  private async openWorld(id: string, opts: { steal?: boolean; readOnly?: boolean; gen?: number }) {
    if (!this.session) return;
    this.say('正在讀取…');
    const r = await this.session.open(id, opts);
    if (!r.ok) {
      if (r.code === 'not_writer') { this.say(`另一個分頁正在使用這個世界。<button type="button" data-act="steal" data-id="${esc(id)}"${opts.gen !== undefined ? ` data-gen="${opts.gen}"` : ''}>切換到此分頁</button> <button type="button" data-act="readonly" data-id="${esc(id)}"${opts.gen !== undefined ? ` data-gen="${opts.gen}"` : ''}>唯讀開啟（不存檔）</button>`, 'warn'); return; }
      this.say(`無法讀取：${esc(r.code)}｜${esc(r.message)}`, 'error'); return;
    }
    this.hide();
    this.hooks.enter(r.value.recovered ? 'recovered' : 'loaded');
    if (r.value.notice) this.hooks.message(`⚠ ${esc(r.value.notice)}`, 'warn');
  }

  async render() {
    const cont = this.root.querySelector('#mContinue') as HTMLButtonElement, info = this.root.querySelector('#mContinueInfo') as HTMLElement;
    if (!this.session) { for (const b of this.root.querySelectorAll('button')) (b as HTMLButtonElement).disabled = b.id !== 'mNew'; this.panel.innerHTML = this.view === 'new' ? this.newForm() : ''; return; }
    const list = await this.session.list(), rts = new Map<string, RuntimeInfo>();
    for (const w of list) if (!rts.has(w.engine_version)) rts.set(w.engine_version, await this.session.runtimeFor(w.engine_version));
    const lastId = await this.session.store.lastPlayed(), last = list.find((w) => w.world_id === lastId);
    cont.disabled = !last || !loadable(last);
    info.textContent = last ? `${last.name}｜${simTime(last.t_sim)}｜上次儲存 ${when(last.last_saved_at)}${loadable(last) ? '' : `｜${COMPAT[last.compat]}`}` : '（沒有存檔）';
    if (this.view === 'home') { this.panel.innerHTML = ''; return; }
    if (this.view === 'new') { this.panel.innerHTML = this.newForm(); (this.panel.querySelector('#nName') as HTMLInputElement)?.focus(); return; }
    const rows = list.map((w) => this.row(w, rts.get(w.engine_version)!)).join('') || '<p class="muted">沒有存檔。</p>';
    const imp = this.view === 'manage' ? `<div class="mrow"><b>匯入備份</b>（.json，最大 ${kb(MAX_IMPORT_BYTES)}；只檢查與讀取資料，不執行任何內容）<br><input type="file" id="importFile" accept=".json,application/json"> <button type="button" data-act="import">匯入</button><span id="copyOffer"></span></div>` : '';
    this.panel.innerHTML = `<h3>${this.view === 'load' ? '讀取存檔' : '存檔管理'}</h3>${imp}${rows}`;
  }
  private newForm() {
    return `<h3>開始新遊戲</h3><div class="mrow"><label>世界名稱 <input id="nName" maxlength="200" placeholder="（可留空）"></label><br><label>種子 <input id="nSeed" placeholder="留空＝隨機；整數 0～4294967295 或任意文字"></label><br><label>世界 <select id="nWorld" aria-label="世界種類"><option value="p0a2" selected>P0-A2 24 小時個體行為世界（候選／實驗世界，非正式）</option><option value="synthetic">合成測試世界（不是螞蟻科學模型）</option></select></label><br><span class="muted">新世界 ID 以 exp- 開頭、永不覆寫其他世界；從實驗 Day0（第 0 天 00:00）開始，建立後立即存入初始快照。P0-A2 世界：30 隻小工蟻、8 隻幼蟲、一個情境蜜露源、合成天氣；<b>不是正式 Day0</b>（Owner #201：未經 Owner 核准不建立正式 Day0）。文字種子以 SHA-256 前 4 位元組轉成整數並顯示。</span><br><button type="button" class="primary" data-act="create">建立並開始</button></div>`;
  }
  private row(w: WorldListing, rt: { rules_fingerprint: string; engine_version: string }) {
    const id = esc(w.world_id), ok = loadable(w);
    const prov = w.provenance ? `<br><span class="muted">副本：來源世界 ${esc(w.provenance.source_world_id)}（${esc(w.provenance.source_name)}）、來源快照 SHA-256 ${esc(w.provenance.source_payload_sha256.slice(0, 12))}…、匯入於 ${when(w.provenance.imported_at)}；${esc(w.provenance.verification)}</span>` : '';
    const ver = w.compat === 'rules_mismatch' || w.compat === 'newer_schema' || w.compat === 'unknown_schema' || w.compat === 'no_migration_path' ? `<br><span class="warn">${COMPAT[w.compat]}：${versionDiff(w, rt)}。存檔保持原樣，可以匯出備份。</span>` : '';
    const last = w.last_save ? `｜上次存檔大小 ${kb(w.last_save.bytes)}、耗時 ${w.last_save.ms} ms` : '';
    const manual = w.manual.length ? `<br>手動存檔（不被自動存檔輪替）：${w.manual.slice().reverse().map((m) => `<button type="button" data-act="loadgen" data-id="${id}" data-gen="${m.gen}"${ok ? '' : ' disabled'}>${esc(simTime(m.t_sim))}</button>`).join(' ')}` : '';
    const head = `<b>${esc(w.name)}</b> <span class="flag">非正式</span><br><span class="muted">${id}${w.sim_world_id !== w.world_id ? `（快照內世界 ${esc(w.sim_world_id)}）` : ''}｜種子 ${w.seed}｜${simTime(w.t_sim)}｜上次儲存 ${when(w.last_saved_at)}${last}｜${individuals(w)}｜回復點 ${w.verified_snapshots}${w.quarantined ? `、隔離 ${w.quarantined}` : ''}｜${COMPAT[w.compat] ?? w.compat}</span>${prov}${ver}`;
    if (this.view === 'load') return `<div class="mrow" data-world="${id}">${head}<br><button type="button" class="primary" data-act="load" data-id="${id}"${ok ? '' : ' disabled'}>讀取最新存檔</button>${manual}</div>`;
    const del = this.pendingDelete?.world_id === w.world_id
      ? `<span class="warn">確定刪除「${esc(w.name)}」與它的全部存檔？此動作無法復原。</span> <button type="button" class="danger" data-act="delete2" data-id="${id}">確定刪除</button> <button type="button" data-act="delcancel">取消</button>`
      : `<button type="button" data-act="delete1" data-id="${id}">刪除…</button>`;
    return `<div class="mrow" data-world="${id}">${head}<br><input class="rename" data-id="${id}" value="${esc(w.name)}" maxlength="200" aria-label="新名稱"> <button type="button" data-act="rename" data-id="${id}">改名</button> <button type="button" data-act="export" data-id="${id}">匯出</button> ${del}</div>`;
  }

  private async onClick(e: Event) {
    const b = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null; if (!b || !this.session && b.dataset.act !== 'create') return;
    const act = b.dataset.act, id = b.dataset.id ?? '', gen = b.dataset.gen === undefined ? undefined : Number(b.dataset.gen);
    const S = this.session!;
    switch (act) {
      case 'create': {
        if (!this.session) { this.say('無法存檔的瀏覽器不能建立存檔世界；可以用「?seed=N」開啟不存檔的臨時實驗。', 'error'); return; }
        const name = (this.panel.querySelector('#nName') as HTMLInputElement).value, seed = (this.panel.querySelector('#nSeed') as HTMLInputElement).value;
        const kind = ((this.panel.querySelector('#nWorld') as HTMLSelectElement | null)?.value === 'synthetic' ? 'synthetic' : 'p0a2') as WorldKind;
        b.disabled = true; this.say('正在建立新世界並寫入初始快照…');
        const r = await S.newGame(name, seed, kind); b.disabled = false;
        if (!r.ok) { this.say(`建立失敗：${esc(r.code)}｜${esc(r.message)}`, 'error'); return; }
        this.hide(); this.hooks.enter('new');
        this.hooks.message(`新世界已建立並存入初始快照（種子 ${r.value.seed}${r.value.how === 'text' ? '，由文字轉換' : r.value.how === 'random' ? '，隨機產生' : ''}）`);
        return;
      }
      case 'load': return this.openWorld(id, {});
      case 'loadgen': return this.openWorld(id, { gen });
      case 'steal': return this.openWorld(id, { steal: true, gen });
      case 'readonly': return this.openWorld(id, { readOnly: true, gen });
      case 'rename': {
        const inp = this.panel.querySelector(`input.rename[data-id="${CSS.escape(id)}"]`) as HTMLInputElement;
        const r = await S.rename(id, inp.value); this.say(r.ok ? '已改名。' : `改名失敗：${esc(r.code)}｜${esc(r.message)}`, r.ok ? 'info' : 'error'); return this.render();
      }
      case 'delete1': { const t = S.store.prepareDelete(id), w = (await S.list()).find((x) => x.world_id === id); this.pendingDelete = { ...t, name: w?.name ?? id }; return this.render(); }
      case 'delcancel': this.pendingDelete = null; return this.render();
      case 'delete2': {
        if (!this.pendingDelete || this.pendingDelete.world_id !== id) return;
        const r = await S.remove(this.pendingDelete); this.pendingDelete = null;
        this.say(r.ok ? '已刪除。' : `刪除失敗：${esc(r.code)}｜${esc(r.message)}`, r.ok ? 'info' : 'error'); return this.render();
      }
      case 'export': {
        const r = await S.store.exportWorld(id);
        if (!r.ok) { this.say(`匯出失敗：${esc(r.code)}｜${esc(r.message)}`, 'error'); return; }
        const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([r.value.text], { type: 'application/json' })); a.download = r.value.filename; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        this.say(`已匯出 ${esc(r.value.filename)}（${kb(r.value.text.length)}）。這是本機備份檔，不是正式存檔。`); return;
      }
      case 'import': {
        const f = (this.panel.querySelector('#importFile') as HTMLInputElement).files?.[0];
        if (!f) { this.say('請先選擇檔案。', 'warn'); return; }
        if (f.size > MAX_IMPORT_BYTES) { this.say(`檔案太大（${kb(f.size)}；上限 ${kb(MAX_IMPORT_BYTES)}），未讀取。`, 'error'); return; }
        const text = await f.text(), r = await S.store.importWorld(text, await S.runtimeForImport(text));
        if (r.ok) { this.say(`已匯入「${esc(f.name)}」為新世界（${esc(r.value.receipt.world_id)}）。`); this.pendingCopyText = null; return this.render(); }
        if (r.code === 'world_exists') { this.pendingCopyText = text; this.say(`此世界已存在，不會覆寫。<button type="button" data-act="importcopy">匯入為副本</button>（新的世界 ID；保留來源世界 ID 與快照驗證紀錄；世界狀態不變）`, 'warn'); return; }
        this.say(`匯入失敗：${esc(r.code)}｜${esc(r.message)}`, 'error'); return;
      }
      case 'importcopy': {
        if (!this.pendingCopyText) return;
        const r = await S.store.importWorldAsCopy(this.pendingCopyText, await S.runtimeForImport(this.pendingCopyText)); this.pendingCopyText = null;
        this.say(r.ok ? `已匯入為副本：${esc(r.value.receipt.world_id)}（來源 ${esc(r.value.provenance.source_world_id)}）。` : `匯入副本失敗：${esc(r.code)}｜${esc(r.message)}`, r.ok ? 'info' : 'error');
        this.view = 'manage'; return this.render();
      }
    }
  }
}
