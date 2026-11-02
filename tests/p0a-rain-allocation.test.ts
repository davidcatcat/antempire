/** P0-A rain allocation arithmetic (design #42 §7.3; reference implementation, not engine code). */
import assert from 'node:assert/strict';
import { allocateRain, splitAtMidnight, NM_PER_MM } from '../reports/p0a-24h-clock/rain-allocation.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
ok(NM_PER_MM === 1e6, 'internal unit is 10⁻⁶ mm = 1 nm (1 µm would be 10⁻³ mm)');
const a = allocateRain(0.123456, [1, 1, 1]);
ok(a.total_nm === 123456 && a.parts_nm.reduce((x, y) => x + y, 0) === 123456, `D = 0.123456 mm -> 123456 nm split exactly (${a.parts_nm})`);
ok(JSON.stringify(a.parts_nm) === JSON.stringify([41152, 41152, 41152]), 'equal weights give equal parts');
const b = allocateRain(0.000001, [3, 2, 5]);
ok(b.parts_nm.reduce((x, y) => x + y, 0) === 1 && b.parts_nm[2] === 1, 'the smallest representable rain (1 nm) goes to the largest remainder');
const c = allocateRain(12.3, [0.2, 0.3, 0.5]);
ok(c.total_nm === 12300000 && c.parts_nm.reduce((x, y) => x + y, 0) === 12300000, '12.3 mm conserved exactly');
const d = allocateRain(0.1234567, [1]);
ok(d.total_nm === 123457 && Math.abs(d.rounding_residual_nm - -0.3) < 1e-6, `finer source precision is reported as a residual (${d.rounding_residual_nm} nm), not dropped`);
ok(allocateRain(0, [1, 2]).parts_nm.every((x) => x === 0), 'a dry day allocates nothing');
assert.throws(() => allocateRain(1, [0, 0]), RangeError); checks++;
for (const [s, e, amt] of [[1380, 1500, 123456], [0, 60, 999], [1439, 1441, 1]] as const) {
  const r = splitAtMidnight(s, e, amt);
  ok(r.today_nm + r.next_day_nm === amt && r.today_nm >= 0 && r.next_day_nm >= 0, `event ${s}-${e} split at midnight conserves ${amt} nm (${r.today_nm} + ${r.next_day_nm})`);
}
// determinism
ok(JSON.stringify(allocateRain(0.123456, [0.37, 0.21, 0.42])) === JSON.stringify(allocateRain(0.123456, [0.37, 0.21, 0.42])), 'same input, same allocation');
console.log(`p0a-rain-allocation: ${checks} checks passed`);
