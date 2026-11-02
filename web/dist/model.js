/**
 * Viewer data model: pure functions over the exported files (web/data/*.json). No DOM, no engine import, no
 * randomness, no writes. Everything returned is either copied from the export or a DISPLAY interpolation that is
 * marked as such; nothing here creates an ecological event, an individual or a behaviour.
 */
export const NEST = 'N00';
/** Display positions (cm, x east / y north) for every place; places without a recorded bearing+distance get a slot in an
 *  "unknown position" tray drawn apart from the map (never an invented garden position). */
export function displayPositions(places) {
    const out = {};
    const known = places.filter((p) => p.layout);
    const minX = Math.min(0, ...known.map((p) => p.layout.x)), minY = Math.min(0, ...known.map((p) => p.layout.y));
    let k = 0;
    for (const p of [...places].sort((a, b) => (a.id < b.id ? -1 : 1))) {
        if (p.layout)
            out[p.id] = { x: p.layout.x, y: p.layout.y, known: true };
        else
            out[p.id] = { x: minX - 20 + 18 * k++, y: minY - 25, known: false };
    }
    return out;
}
/** The colony as it was at the START of experiment day `day` (= end of the previous day). */
export function stateAtStart(exp, day) {
    return day <= 1 ? exp.day0.state : exp.days[day - 2].end_state;
}
/** Recorded activity segments of one worker on one day, in time order. */
export function segmentsOf(d, workerId) {
    return d.events.filter((e) => e.type === 'worker_activity' && e.worker === workerId).sort((a, b) => a.start - b.start || a.end - b.end);
}
/**
 * Where to DRAW a worker at minute t of a day. Recorded points: the engine's route_step events (arrival minute at
 * each node of a walk) and activity segment boundaries. Between two recorded points the position is linearly
 * interpolated for display only (`interpolated: true`). Workers with no segment are drawn where the engine last
 * placed them (the nest). This function never produces events.
 */
export function poseAt(d, workerId, t, pos, nest = NEST) {
    const segs = segmentsOf(d, workerId);
    let here = nest;
    for (const s of segs) {
        const start = s.start, end = s.end, place = s.place;
        if (t < start)
            break;
        if (place.includes('>')) {
            const route = place.split('>');
            if (t <= end) {
                // arrival minutes at each node, from the engine's route_step events of this walk
                const steps = d.events.filter((e) => e.type === 'route_step' && e.worker === workerId && e.minute > start - 1e-9 && e.minute <= end + 1e-9);
                const times = [start];
                for (let i = 1; i < route.length; i++) {
                    const st = steps.find((e) => e.from === route[i - 1] && e.to === route[i] && e.minute >= times[i - 1] - 1e-9);
                    times.push(st ? st.minute : start + ((end - start) * i) / (route.length - 1));
                }
                for (let i = 1; i < route.length; i++) {
                    if (t <= times[i] + 1e-9) {
                        const a = pos[route[i - 1]], b = pos[route[i]], f = times[i] > times[i - 1] ? (t - times[i - 1]) / (times[i] - times[i - 1]) : 1;
                        if (!a || !b)
                            return { x: (b ?? a ?? { x: 0 }).x, y: (b ?? a ?? { y: 0 }).y, place: route[i], action: s.action, interpolated: true, segment: s };
                        return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, place: `${route[i - 1]}>${route[i]}`, action: s.action, interpolated: f > 0 && f < 1, segment: s };
                    }
                }
            }
            here = route[route.length - 1];
        }
        else {
            if (t <= end) {
                const p = pos[place] ?? pos[nest];
                return { x: p.x, y: p.y, place, action: s.action, interpolated: false, segment: s };
            }
            here = place;
        }
    }
    const p = pos[here] ?? pos[nest];
    return { x: p.x, y: p.y, place: here, action: here === nest ? 'in_nest' : 'at_site', interpolated: false, segment: null };
}
/** Events of a day up to minute t (events without a minute happen at the end of the day: included only when t >= window). */
export function eventsUntil(d, t) {
    const w = d.window_minutes ?? 360;
    return d.events.filter((e) => e.type !== 'worker_activity' && e.type !== 'route_step' && ((typeof e.minute === 'number' ? e.minute : typeof e.start === 'number' ? e.start : w + 1) <= t || t >= w));
}
/** Union of the route edges remembered by the workers alive at the start of the day (observer overlay). */
export function exploredEdges(s) { return new Set(s.workers.flatMap((w) => w.route_edges)); }
const EVENT_LABEL = {
    discovery: '發現食源', scouted_empty: '到達但沒有食物', exploration_step: '探索新路段', exploration_found_nothing: '探索沒有發現', food_collected: '採集', food_delivered: '回巢卸貨', trophallaxis: '交哺', local_recruitment: '招募同伴', hunt_recruitment: '捕獵招募', live_prey_encounter: '遇到活獵物', insect_predation: '捕獲獵物', prey_escaped: '獵物逃走', joint_prey_transport: '共同搬運', worker_death: '工蟻死亡', brood_death: '幼體死亡', queen_death: '蟻后死亡', egg_laid: '產卵', hatch: '孵化', pupation: '化蛹', eclosion: '羽化', forager_stopped: '停止覓食', action_cancelled_no_time: '時間不足取消', insect_natural_death: '昆蟲自然死亡', host_plant_death: '寄主植物死亡', hemipteran_colony_change: '半翅目族群變化',
};
export const ACTION_LABEL = { foraging_depart: '出巢覓食', foraging_return: '回巢', search: '搜尋', collect: '採集', unload: '卸貨', rest: '巢內休息', explore_depart: '出去探索', explore_return: '探索後回巢', trail_follow_depart: '沿費洛蒙出發', recruit_follow_trail: '跟隨招募', hunt_recruit_trail_home: '回巢招募捕獵', hunt_recruit_lead: '帶領捕獵隊', hunt_recruit_follow_trail: '跟隨捕獵隊', prey_handling: '處理獵物', hold_prey: '守住獵物', joint_prey_transport: '共同搬運', in_nest: '在巢內', at_site: '在地點' };
export const TASK_LABEL = { forage: '覓食', nurse: '照護', rest: '休息', repair: '修繕', guard: '守衛' };
export const REASON_LABEL = { gave_up_after_unsuccessful_trip: '空手而回後放棄', own_motivation_after_unloading: '卸貨後不再出去', no_time_left_in_activity_window: '時間不足', activity_window_closed: '活動時段結束', no_known_route_and_no_exploration: '不知道路也沒去探索', starvation_or_natural_competing_hazards_scenario: '飢餓與自然風險', natural_or_injury_assumed: '自然或傷害', chronic_protein_shortage_game_scenario: '長期蛋白不足', unattended_brood_no_worker_care_game_assumption: '無人照護', no_workers: '沒有工蟻', chronic_sugar_deficit: '長期缺糖', chronic_protein_deficit: '長期缺蛋白', chronic_sugar_and_protein_deficit: '長期缺糖與蛋白', failed_capture: '捕捉失敗', escaped_while_recruiting: '招募時逃走' };
export function describeEvent(e) {
    const who = e.worker ?? (e.by ? `${e.by}→${e.to}` : e.id ?? '');
    const where = e.site ?? e.node ?? e.location ?? '';
    const reason = typeof e.reason === 'string' ? ` ${REASON_LABEL[e.reason] ?? e.reason}` : '';
    const extra = e.type === 'food_collected' || e.type === 'food_delivered' ? ` ${e.macro === 'sugar' ? '糖' : '蛋白'} ${Number(e.portions).toFixed(2)} 份` : reason;
    return `${EVENT_LABEL[e.type] ?? e.type}${who ? ' ' + who : ''}${where ? ' @' + where : ''}${extra}`;
}
