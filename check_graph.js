#!/usr/bin/env node
/*
 * check_graph.js — проверка graph.json после сборки:  node check_graph.js
 *  • граф связный (кроме комнат, до которых нельзя дойти по плану);
 *  • контрольные маршруты идут так, как задумано (лестницы, музей, восточное крыло 1 этажа);
 *  • рёбра не проходят сквозь стены комнат.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const g = JSON.parse(fs.readFileSync(path.join(__dirname, 'graph.json'), 'utf8'));
const N = g.nodes;
const adj = Object.fromEntries(Object.keys(N).map(k => [k, []]));
for (const e of g.edges) {
  const [a, b] = e;
  const w = e.length > 2 ? e[2] : Math.hypot(N[a].x - N[b].x, N[a].y - N[b].y);
  adj[a].push([b, w]); adj[b].push([a, w]);
}

let bad = 0;
const fail = m => { bad++; console.log('  ✗ ' + m); };
const ok = m => console.log('  ✓ ' + m);

function route(s, t) {
  const dist = { [s]: 0 }, prev = {}, done = new Set();
  const goal = t instanceof Set ? t : new Set([t]);
  const pq = [[0, s]];
  let end = null;
  while (pq.length) {
    pq.sort((a, b) => a[0] - b[0]);
    const [d, u] = pq.shift();
    if (done.has(u)) continue;
    done.add(u);
    if (goal.has(u)) { end = u; break; }
    for (const [v, w] of adj[u]) if (d + w < (dist[v] ?? Infinity)) { dist[v] = d + w; prev[v] = u; pq.push([d + w, v]); }
  }
  if (end === null) return null;
  const p = [end];
  while (p[0] !== s) p.unshift(prev[p[0]]);
  return { path: p, px: Math.round(dist[end]) };
}
const floorsOf = p => p.reduce((a, id) => (a[a.length - 1] === N[id].floor ? a : [...a, N[id].floor]), []);
const stairsOf = p => p.filter(id => N[id].type === 'stairs');

console.log('Связность');
const seen = new Set(), st = [Object.keys(N).find(k => k.startsWith('a2'))];
while (st.length) { const u = st.pop(); if (seen.has(u)) continue; seen.add(u); for (const [v] of adj[u]) st.push(v); }
const lost = Object.keys(N).filter(k => !seen.has(k));
lost.length ? fail(`недостижимы ${lost.length} узлов: ${lost.slice(0, 12).join(', ')}`) : ok(`все ${Object.keys(N).length} узлов связаны`);

console.log('Контрольные маршруты');
const has = id => id in N;
function expect(from, to, check, what) {
  if (!has(from) || !has(to)) return fail(`${what}: нет узла ${from} или ${to}`);
  const r = route(from, to);
  if (!r) return fail(`${what}: маршрут не найден`);
  const info = `${from}→${to}: ${r.px}px, этажи ${floorsOf(r.path).join('→')}`;
  check(r) ? ok(`${what} (${info})`) : fail(`${what} (${info}; лестницы: ${stairsOf(r.path).join(', ')})`);
}
// восточное крыло 1 этажа — только по лестнице со 2 этажа
const wing1 = Object.keys(N).find(k => N[k].floor === 1 && N[k].num === '152' && k.startsWith('a'));
if (wing1) expect('a118', wing1, r => floorsOf(r.path).join() === '1,2,1', 'в восточное крыло 1 этажа только через 2 этаж');
expect('a203', 'a161', r => floorsOf(r.path).join() === '2,1', 'со 2 этажа в крыло 1 этажа');
// главная лестница в подвал закрыта
expect('f2_entr_main', 'a118', r => !stairsOf(r.path).includes('f2_st_mid_s') || !stairsOf(r.path).includes('f1_st_mid_s'), 'в подвал не по главной лестнице');
// музей: 427 -> 437 только по лестницам
expect('a427', 'a437', r => !r.path.slice(1, -1).includes('f4_museum') && floorsOf(r.path).join() === '4,3,4', '427→437 не через музей');
expect('a203', 'a417', r => floorsOf(r.path).join() === '2,3,4', 'со 2 на 4 этаж');
// ближайший туалет (учитываем, что туалет для маломобильных подходит всем)
const wcs = sex => new Set(Object.keys(N).filter(k => N[k].type === 'room' && new RegExp(`_wc_${sex}_\\d+$`).test(k)));
for (const sex of ['m', 'f']) {
  const r = route('a203', wcs(sex));
  r ? ok(`ближайший туалет (${sex}) от 203: ${r.path[r.path.length - 1]}, ${r.px}px`) : fail(`туалет ${sex} недостижим`);
}

console.log('Рёбра сквозь стены комнат');
const rects = {};
for (const [id, n] of Object.entries(N)) if (n.rect) (rects[n.floor] = rects[n.floor] || []).push({ id, r: [n.rect[0], n.rect[1], n.rect[0] + n.rect[2], n.rect[1] + n.rect[3]] });
let crossings = 0;
for (const e of g.edges) {
  const A = N[e[0]], B = N[e[1]];
  if (A.floor !== B.floor) continue;
  for (const { id, r } of rects[A.floor] || []) {
    if (id === e[0] || id === e[1]) continue;
    const own = n => ['room', 'stairs', 'entrance'].includes(n.type) && r[0] - 0.5 <= n.x && n.x <= r[2] + 0.5 && r[1] - 0.5 <= n.y && n.y <= r[3] + 0.5;
    if (own(A) || own(B)) continue;
    let hit = false;
    for (let i = 1; i < 40 && !hit; i++) {
      const x = A.x + (B.x - A.x) * i / 40, y = A.y + (B.y - A.y) * i / 40;
      hit = r[0] + 2 < x && x < r[2] - 2 && r[1] + 2 < y && y < r[3] - 2;
    }
    if (hit) { crossings++; console.log(`  ! этаж ${A.floor}: ребро ${e[0]} – ${e[1]} пересекает ${id}`); break; }
  }
}
crossings ? console.log(`  (пересечений: ${crossings} — посмотрите, нормально ли)`) : ok('пересечений нет');

console.log(bad ? `\nПроблем: ${bad}` : '\nВсё хорошо');
process.exit(bad ? 1 : 0);
