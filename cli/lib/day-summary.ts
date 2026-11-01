/** Human-readable event summary of one simulated day, as raw material for writing the journal. */
type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const count = (events: Any[], type: string) => events.filter((e) => e.type === type);

/** `embedded`: section inside the committed journal (no H1, headings one level down). */
export function daySummaryMarkdown(report: Any, checks: { name: string; ok: boolean; level: string }[], opts: { embedded?: boolean } = {}): string {
  const r = report.summary, ev: Any[] = report.events, w = r.weather;
  const lines: string[] = [];
  if (opts.embedded) lines.push('## 當日事件整理（自動產生）', '', '> 由 `npm run advance` 依引擎輸出自動整理，與上方事件紀錄同源。所有「份」是遊戲單位，不是 mg；天氣是歷史氣候合成值，不是實測。', '');
  else lines.push(`# Day ${report.day}（${r.date}）事件摘要`, '', '> 由 `npm run advance` 自動產生。所有「份」是遊戲單位，不是 mg；天氣是歷史氣候合成值，不是實測。', '');
  const h = (t: string) => (opts.embedded ? '### ' : '## ') + t;
  lines.push(h('天氣（合成）'), `- 降雨 ${w.rain_mm} mm（${w.wet ? '雨日' : '無雨'}），日均氣溫 ${w.air_temp_c}°C，白天最高 ${w.daytime_air_temp_c}°C，最低 ${w.daily_min_air_temp_c}°C，模型巢溫 ${w.nest_temp_model_c}°C，相對濕度 ${w.relative_humidity_model_percent}%，土表濕潤指數 ${w.soil_index}`, '');
  lines.push(h('蟻群人口'), '| 項目 | 數量 |', '|---|---:|', `| 蟻后 | ${r.population.queen} |`, `| 工蟻 | ${r.population.workers}（前一日 ${r.workers_before}，羽化 +${r.eclosions}，死亡 −${r.worker_deaths}） |`, `| 卵 | ${r.population.eggs}（新產 ${r.eggs_laid}） |`, `| 幼蟲 | ${r.population.larvae}（孵化 ${r.hatchings}） |`, `| 蛹 | ${r.population.pupae}（化蛹 ${r.pupations}） |`, `| 幼體死亡 | ${r.brood_deaths} |`, '');
  lines.push(h('食物帳（遊戲份）'), '| | 期初 | 採入 | 消耗 | 產卵 | 溢出 | 期末 | 需求 | 滿足率 |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const k of ['sugar', 'protein']) lines.push(`| ${k === 'sugar' ? '糖' : '蛋白'} | ${r.mass_ledger.start[k]} | ${r.income[k]} | ${r.consumed[k]} | ${r.mass_ledger.egg_laying[k]} | ${r.mass_ledger.storage_overflow_not_retained[k]} | ${r.stock[k]} | ${r.demand[k]} | ${r.ratios[k]} |`);
  lines.push('', `連續缺糖 ${r.starvation.sugar_gap_days} 日、缺蛋白 ${r.starvation.protein_gap_days} 日。`, '');
  lines.push(h('工蟻任務'), Object.entries(r.tasks).map(([k, v]) => `${k} ${v}`).join('、') + `；外出趟數 ${r.foraging_trips}、成功帶回 ${r.foraging_successes}、招募 ${r.recruited}。`, '');
  const list = (title: string, items: string[]) => { lines.push(h(title)); lines.push(...(items.length ? items.map((x) => '- ' + x) : ['- （無）'])); lines.push(''); };
  list('食物帶回巢', count(ev, 'food_delivered').map((e) => `${e.worker} 從 ${e.site} 帶回${e.macro === 'sugar' ? '糖' : '蛋白'} ${e.portions} 份${e.trophallaxis_portions ? `（巢內交哺 ${e.trophallaxis_portions} 份）` : ''}`));
  list('發現與探索', [...count(ev, 'discovery').map((e) => `${e.worker} 親身抵達並確認 ${e.site}（${e.food_kind}）`), ...count(ev, 'scouted_empty').map((e) => `${e.worker} 抵達 ${e.site}，無活寄主`), ...count(ev, 'physical_scout_visit').map((e) => `${e.worker} 經 ${e.via} 探訪 ${e.site}`), ...count(ev, 'route_timeout').map((e) => `${e.worker} 去 ${e.site} 的路程超出當日時間，未出發`)]);
  list('招募', count(ev, 'local_recruitment').map((e) => `${e.by} 沿路段招募 ${e.to} 前往 ${e.site}`));
  list('捕食', [...count(ev, 'insect_predation').map((e) => `${e.site} 捕獲${e.size === 'large' ? '大型' : '小型'}活昆蟲（隊伍 ${e.team.join('、')}，來源 ${e.event_id}）`), ...count(ev, 'prey_escaped').map((e) => `${e.site} 獵物逃脫（${e.reason}）`)]);
  list('發育與產卵', [...count(ev, 'egg_laid').map((e) => `${e.queen} 產下 ${e.id}`), ...count(ev, 'hatch').map((e) => `${e.id} 孵化為幼蟲`), ...count(ev, 'pupation').map((e) => `${e.id} 化蛹`), ...count(ev, 'eclosion').map((e) => `${e.source_brood_id} 羽化為 ${e.new_worker_id}（${e.caste}）`)]);
  list('死亡與傷勢', [...count(ev, 'worker_death').map((e) => `${e.id} 死亡（${e.reason}，風險 ${e.risk_assumption}）`), ...count(ev, 'brood_death').map((e) => `${e.id}（${e.stage}）死亡（${e.reason}）`), ...count(ev, 'queen_death').map((e) => `蟻后 ${e.id} 死亡（${e.reason}）`), ...count(ev, 'injury_recovery').map((e) => `${e.id} 舊傷復原`)]);
  list('花園生態（與蟻群無關）', [...count(ev, 'insect_natural_death').map((e) => `${e.site} 昆蟲自然死亡 → 殘骸 ${e.event_id}`), ...count(ev, 'insect_population_birth').map((e) => `${e.site} 昆蟲出生 ${e.individuals}`), ...count(ev, 'insect_background_death').map((e) => `${e.site} 背景死亡 ${e.individuals}`), ...count(ev, 'insect_immigration').map((e) => `昆蟲由鄰地遷入 ${e.site}`), ...count(ev, 'host_plant_death').map((e) => `${e.site} 寄主植物死亡（剩 ${e.hosts_remaining}）`), ...count(ev, 'hemipteran_colony_change').map((e) => `${e.site} 半翅目群 ${e.delta > 0 ? '+1' : '−1'}（剩 ${e.remaining}）`)]);
  const failed = checks.filter((c) => !c.ok);
  lines.push(h('守恆檢查'), `${checks.length} 項：${checks.length - failed.length} 通過${failed.length ? '；未通過：' + failed.map((c) => `${c.name}（${c.level}）`).join('；') : ''}`, '');
  lines.push(`事件總數 ${ev.length}（含路段步行 ${count(ev, 'route_step').length}、費洛蒙衰退 ${count(ev, 'trail_decay').length}、留下 ${count(ev, 'trail_deposited').length}、交哺 ${count(ev, 'trophallaxis').length}）。完整事件列於日誌「事件紀錄」與 saves/world-state.json#/day_log_latest/events。`);
  return lines.join('\n') + '\n';
}
