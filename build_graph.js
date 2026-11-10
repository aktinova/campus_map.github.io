#!/usr/bin/env node
/*
 * build_graph.js — разбирает планы этажей (SVG из Figma) и собирает graph.json.
 *
 * Запуск:   node build_graph.js          (нужен только Node.js 14+, npm-пакеты не нужны)
 *
 * Идея: коридоры каждого этажа заданы ломаными по центру серых зон (см. FLOORS ниже),
 * а двери, лестницы и сервисные точки привязываются к ближайшему коридору автоматически.
 * Этажи соединяются рёбрами между одноимёнными лестницами.
 *
 * Ничего не надо править, если вы просто перерисовали комнаты. Если сдвинули/изменили
 * сами коридоры или лестницы — поправьте числа в FLOORS (там у каждого этажа свой блок).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const DIR = __dirname;

// «Стоимость» подъёма/спуска на один этаж в пикселях плана. Чем больше число,
// тем неохотнее маршрут меняет этаж.
const FLOOR_COST = 300;

// Лестницы, по которым между этажами НЕ пройти: "нижний_этаж:ключ_лестницы".
// Главная лестница в подвал (1 этаж) закрыта — двери заперты.
const BLOCKED_LINKS = new Set(['1:mid_s']);

/*
 * Нумерация этажей: floor0.svg = 1 этаж, floor1.svg = 2 этаж, floor2.svg = 3 этаж, floor3.svg = 4 этаж.
 *
 * corridors(S) возвращает ломаные коридоров; S — найденные на плане лестницы ({ключ: {x, y}}).
 *   B — главный коридор, A / C — левый и правый вертикальные, D — к восточному крылу,
 *   W — проход через лестницу в крыло (только для маршрута, двери к нему не крепятся),
 *   E — коридор восточного крыла.
 * Одинаковые координаты вершин склеиваются.
 */
const FLOORS = {
  1: {
    svg: 'floor0.svg',
    corridors: S => {
      const P = S.wing_pass;
      return {
        B: [[95, 1012], [317, 1012], [317, 992], [1189, 992], [1215, 970], [1250, 970]],
        A: [[317, 1012], [317, 1300]],          // внизу его перекрывает научно-испытательный центр
        C: [[1189, 992], [1189, 1556]],
        // участка D нет: в восточное крыло 1 этажа попадают только по лестнице со 2 этажа
        W: [[P.x, P.y], [1688, P.y]],
        E: [[1688, 308.5], [1688, P.y], [1688, 1062]],   // сверху и снизу его перекрывают комнаты 168 и 152
      };
    },
    entrance: null,
    overrides: {},
  },
  2: {
    svg: 'floor1.svg',
    corridors: S => {
      const P = S.wing_pass;
      return {
        B: [[190, 1031], [412, 1031], [412, 1010], [1284.5, 1010]],
        A: [[412, 1031], [412, 1555]],
        C: [[1284.5, 1010], [1284.5, P.y], [1284.5, 1555]],
        D: [[1284.5, P.y], [P.x, P.y]],
        W: [[P.x, P.y], [1783.5, P.y]],
        E: [[1783.5, 329], [1783.5, P.y], [1783.5, 1066]],
      };
    },
    entrance: [816, 1120, 'mid_s'],             // вход и лестница, через которую он соединён с коридором
    overrides: {},
  },
  3: {
    svg: 'floor2.svg',
    corridors: S => {
      // слева комната 318 занимает весь конец коридора, справа комната 335 перекрывает путь на восток,
      // поэтому на 3 этаже нет ни левого края B, ни участка D (красная черта на плане).
      const P = S.wing_pass;
      return {
        B: [[412, 1014], [1284.5, 1014]],
        A: [[412, 1014], [412, 1560]],
        C: [[1284.5, 1014], [1284.5, 1558]],
        W: [[P.x, P.y], [1785.25, P.y]],
        E: [[1785.25, 333], [1785.25, P.y], [1785.25, 1070]],
      };
    },
    entrance: null,
    overrides: {},
  },
  4: {
    svg: 'floor3.svg',
    corridors: () => ({
      // восточного крыла нет. Главный коридор упирается в музей (его дверь на плане слева),
      // поэтому B кончается у x=1439. Правый коридор C начинается в тамбуре за правой лестницей.
      B: [[624, 1026], [1439, 1026]],
      A: [[624, 1026], [624, 1495]],            // внизу его перекрывает комната 401
      C: [[1496, 1090], [1496, 1498]],          // внизу его перекрывает комната 448
    }),
    // стрелки выхода на плане: левая лестница выходит влево (в коридор A),
    // правая — вправо (в тамбур коридора C); красная черта закрывает её верхнюю дверь в коридор B
    stairOverrides: { left_n: 'A', right_n: 'C' },
    entrance: null,
    // музей — не проход: входить в него можно только со стороны главного коридора B.
    overrides: { museum: 'B' },
    // на 4 этаже это не помещения, а пустота над двусветными залами 3 этажа
    skipText: ['актовый зал 2 эт', 'спортивный зал 2 эт'],
  },
};

const NAMED = {
  'столовая': 'canteen', 'касса': 'cashier', 'лаборатория': 'lab',
  'цит': 'cit', 'директор цита': 'cit_director',
  'актовый зал': 'assembly_hall', 'спортивный зал': 'gym', 'архив': 'archive',
  'музей': 'museum', 'музей истории': 'museum',
  'библиотека': 'library', 'гардероб': 'cloakroom', 'дирек тор библи отеки': 'library_director',
  'научно-испытательный центр': 'nic',
};
// подписи, которые в SVG разорваны на слоги («дирек / тор / библи / отеки»)
const LABELS = { 'дирек тор библи отеки': 'директор библиотеки' };

const NUM_RE = /^\d+[a-zа-я]?$/;
const TRANSLIT = { 'а': 'a', 'б': 'b', 'в': 'v' };
const STAIR_SIG_LEN = 40;                       // у иконки лестницы 40 команд в контуре
const DESC = {
  mid_n: 'центр (север)', mid_s: 'центр (юг)', left_n: 'левая (север)', left_s: 'левая (юг)',
  right_n: 'правая (север)', right_s: 'правая (юг)', wing_n: 'восточное крыло (север)',
  wing_pass: 'восточная (в крыле)',
};

// ---------------------------------------------------------------- разбор SVG
const attrs = s => {
  const o = {};
  for (const m of s.matchAll(/([\w:-]+)="([^"]*)"/g)) o[m[1]] = m[2];
  return o;
};
const decode = s => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');

function applyTransform(tr, x, y) {
  // поддерживаются translate(...) и rotate(...), как в экспорте Figma
  let a = 0, tx = 0, ty = 0;
  const t = /translate\(\s*([-\d.]+)[ ,]+([-\d.]+)\s*\)/.exec(tr || '');
  if (t) { tx = +t[1]; ty = +t[2]; }
  const r = /rotate\(\s*([-\d.]+)/.exec(tr || '');
  if (r) a = (+r[1]) * Math.PI / 180;
  return [tx + x * Math.cos(a) - y * Math.sin(a), ty + x * Math.sin(a) + y * Math.cos(a)];
}

function pathBox(d) {
  let x = 0, y = 0;
  const pts = [];
  for (const m of d.matchAll(/([MLHVCZ])([^MLHVCZ]*)/g)) {
    const n = (m[2].match(/-?\d*\.?\d+/g) || []).map(Number);
    switch (m[1]) {
      case 'M': case 'L': x = n[0]; y = n[1]; pts.push([x, y]); break;
      case 'H': x = n[0]; pts.push([x, y]); break;
      case 'V': y = n[0]; pts.push([x, y]); break;
      case 'C': for (let i = 0; i + 1 < n.length; i += 2) pts.push([n[i], n[i + 1]]); x = n[n.length - 2]; y = n[n.length - 1]; break;
    }
  }
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const x0 = Math.min(...xs), y0 = Math.min(...ys), x1 = Math.max(...xs), y1 = Math.max(...ys);
  return { x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 };
}

function parseSvg(file) {
  const src = fs.readFileSync(path.join(DIR, file), 'utf8');
  const head = attrs(/<svg\b[^>]*>/.exec(src)[0]);
  const rooms = [], grays = [];
  for (const m of src.matchAll(/<rect\b[^>]*>/g)) {
    const a = attrs(m[0]);
    if (a.width === undefined || a.x === undefined) continue;
    const r = [+a.x, +a.y, +a.x + +a.width, +a.y + +a.height];     // x1, y1, x2, y2
    if ((a.fill || '').toUpperCase() === '#B3B3B3') grays.push(r);
    else if (a.stroke) rooms.push(r);        // заплатки без обводки (закрашенные швы) — не помещения
  }
  const texts = [];
  for (const m of src.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)) {
    const a = attrs(m[1]);
    const lines = [];
    let first = null;
    for (const t of m[2].matchAll(/<tspan\b([^>]*)>([\s\S]*?)<\/tspan>/g)) {
      const ta = attrs(t[1]);
      if (!first) first = [+ta.x, +ta.y];
      const s = decode(t[2]).replace(/\s+/g, ' ').trim();
      if (s) lines.push(s);
    }
    if (first && lines.length) {
      const [x, y] = applyTransform(a.transform, first[0], first[1]);
      texts.push({ lines, x, y });
    }
  }
  const paths = [];
  for (const m of src.matchAll(/<path\b[^>]*>/g)) {
    const a = attrs(m[0]);
    if (!a.d) continue;
    paths.push({ ...pathBox(a.d), fill: a.fill, stroke: a.stroke, sig: a.d.replace(/[^A-Za-z]/g, '') });
  }
  return { w: Math.round(+head.width), h: Math.round(+head.height), rooms, grays, texts, paths };
}

// ---------------------------------------------------------------- вспомогательное
const area = r => (r[2] - r[0]) * (r[3] - r[1]);
const inside = (r, x, y, pad = 0) => r[0] - pad <= x && x <= r[2] + pad && r[1] - pad <= y && y <= r[3] + pad;
const clampToRect = (p, r) => [Math.min(Math.max(p[0], r[0]), r[2]), Math.min(Math.max(p[1], r[1]), r[3])];
const tr = s => [...s.toLowerCase()].map(c => TRANSLIT[c] || c).join('');
const normNum = s => s.toLowerCase().replace(/a/g, 'а');       // латинская «a» в номере (275a) → русская «а»
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const prettyLabel = (names, key) => {
  if (LABELS[key]) return LABELS[key];
  const txt = names.join(' ');
  return txt === txt.toUpperCase() && txt.length > 4 ? txt.toLowerCase() : txt;   // «БИБЛИОТЕКА» → «библиотека», «ЦИТ» остаётся
};

/** Находит на плане лестницы и раздаёт им ключи (left_n, right_s, wing_n …) по положению. */
function findStairs(svg) {
  const icons = svg.paths.filter(p => p.sig.length === STAIR_SIG_LEN && p.fill === 'black' && p.w > 15 && p.w < 25 && p.h > 15 && p.h < 25);
  const main = svg.grays.filter(g => g[2] - g[0] > 900).sort((a, b) => (b[2] - b[0]) - (a[2] - a[0]))[0];
  const verts = svg.grays.filter(g => g[3] - g[1] > 400 && g[2] - g[0] < 300 && g[0] < 1500).sort((a, b) => a[0] - b[0]);
  const east = svg.grays.find(g => g[0] > 1500 && g[3] - g[1] > 800);
  const lx = (verts[0][0] + verts[0][2]) / 2, rx = (verts[verts.length - 1][0] + verts[verts.length - 1][2]) / 2;
  const my = (main[1] + main[3]) / 2;
  const out = {};
  for (const ic of icons) {
    let key;
    if (east && ic.cx > east[0]) key = ic.cy < (east[1] + east[3]) / 2 ? 'wing_n' : 'wing_pass';
    else {
      const t = (ic.cx - lx) / (rx - lx);
      const col = t < 0.25 ? 'left' : t > 0.75 ? 'right' : 'mid';
      const ns = col === 'mid' ? (ic.cy < my ? 'n' : 's') : (ic.cy < main[3] + 150 ? 'n' : 's');
      key = `${col}_${ns}`;
    }
    if (out[key]) throw new Error(`две лестницы с ключом ${key}`);
    out[key] = { x: Math.round(ic.cx * 10) / 10, y: Math.round(ic.cy * 10) / 10 };
  }
  return { stairs: out, main, east };
}

// ---------------------------------------------------------------- построение этажа
function buildFloor(floor, cfg, nodes, edges, svg) {
  const pre = `f${floor}_`;
  const { stairs, main, east } = findStairs(svg);
  const corridors = cfg.corridors(stairs);

  // текст -> самый маленький прямоугольник, который его содержит
  const rectTexts = new Map(svg.rooms.map(r => [r, []]));
  for (const tx of svg.texts) {
    const cands = svg.rooms.filter(r => r[0] - 3 <= tx.x && tx.x <= r[2] && r[1] <= tx.y && tx.y <= r[3] + 2);
    if (cands.length) rectTexts.get(cands.reduce((a, b) => (area(a) <= area(b) ? a : b))).push(tx);
  }

  const addNode = (id, x, y, extra) => { nodes[id] = { floor, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, ...extra }; };

  // вершины коридоров (одинаковые координаты склеиваются)
  const verts = new Map();
  const cv = (x, y) => {
    const k = `${x},${y}`;
    if (!verts.has(k)) { const id = `${pre}c${verts.size}`; verts.set(k, id); addNode(id, x, y, { type: 'corridor' }); }
    return verts.get(k);
  };
  const segments = [];
  for (const [name, poly] of Object.entries(corridors)) {
    for (let i = 0; i + 1 < poly.length; i++) {
      const p = poly[i], q = poly[i + 1];
      segments.push({ p, q, a: cv(...p), b: cv(...q), items: [], name });
    }
  }

  const project = (pt, only) => {
    let best = null;
    segments.forEach((s, si) => {
      if (s.name === 'W' || (only && s.name !== only)) return;     // W — только для маршрута, двери к нему не крепим
      const [ax, ay] = s.p, [bx, by] = s.q;
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      const t = Math.max(0, Math.min(1, ((pt[0] - ax) * dx + (pt[1] - ay) * dy) / L2));
      const px = ax + t * dx, py = ay + t * dy, d = Math.hypot(pt[0] - px, pt[1] - py);
      if (!best || d < best.d) best = { d, p: [px, py], si, t };
    });
    if (!best) throw new Error(`на ${floor} этаже нет коридора ${only}`);
    return best;
  };
  const attach = (nid, pt, only) => {
    const b = project(pt, only);
    const pid = `${pre}p_${nid}`;
    addNode(pid, b.p[0], b.p[1], { type: 'corridor' });
    segments[b.si].items.push([b.t, pid]);
    edges.push([nid, pid]);
  };

  // ---------- помещения ----------
  const items = [], used = new Set(), wc = { m: 0, f: 0, a: 0 };
  const iconsIn = r => svg.paths.filter(p => inside(r, p.cx, p.cy));
  for (const [r, tl] of rectTexts) {
    const w = r[2] - r[0], h = r[3] - r[1];
    if (!tl.length) {
      if (w <= 27 && h <= 27) {                    // маленькие квадраты с иконкой (принтер / кофе)
        const ic = iconsIn(r)[0];
        const coffee = ic ? ic.h > ic.w + 1.5 : r[0] > 800;
        const kind = coffee ? 'coffee' : 'printer';
        let b = kind, k = 2;
        while (used.has(pre + b)) b = `${kind}_${k++}`;
        items.push({ base: b, id: pre + b, rect: r, aliases: [], label: coffee ? 'кофе-аппарат' : 'принтер', title: coffee ? 'Кофе-аппарат' : 'Принтер' });
        used.add(pre + b);
      }
      continue;
    }
    tl.sort((a, b) => a.y - b.y);
    const words = tl.flatMap(t => t.lines);
    if ((cfg.skipText || []).includes(words.join(' ').toLowerCase())) continue;
    const nums = words.filter(x => NUM_RE.test(x.toLowerCase()));
    const names = words.filter(x => !NUM_RE.test(x.toLowerCase()));
    let item;
    if (names.length && names[0].toLowerCase() === 'туалет') {
      // пол определяем по силуэту человечка: контур из 38 команд — мужчина, из 44 — женщина; значок-коляска — туалет для маломобильных
      let sex = null;
      for (const p of iconsIn(r)) {
        if (p.sig.length === 38) sex = 'm';
        else if (p.sig.length === 44) sex = 'f';
        else if (!p.fill && p.stroke === 'black' && p.sig.length === 34) sex = 'a';
      }
      if (!sex) { console.warn(`   ! ${floor} этаж: у туалета ${JSON.stringify(r)} нет значка, считаю женским`); sex = 'f'; }
      const n = ++wc[sex];
      const kind = { m: 'муж.', f: 'жен.', a: 'для маломобильных' }[sex];
      const title = { m: 'Туалет мужской', f: 'Туалет женский', a: 'Туалет для маломобильных' }[sex];
      item = { base: `wc_${sex}_${n}`, id: `${pre}wc_${sex}_${n}`, rect: r, aliases: [], label: `туалет (${kind}) ${n}, ${floor} эт.`, title };
    } else if (nums.length) {
      const base = 'a' + tr(nums[0]);
      const id = !(base in nodes) && !used.has(base) ? base : `${base}_${floor}`;
      item = { base, id, rect: r, aliases: [...new Set([normNum(nums[0]), tr(nums[0])])].sort(),
               label: [nums[0], ...names].join(' '), num: normNum(nums[0]) };
    } else {
      const key = names.join(' ').toLowerCase();
      const base = NAMED[key] || 'room';
      let b2 = base, k = 2;
      while (used.has(pre + b2)) b2 = `${base}_${k++}`;
      const pl = prettyLabel(names, key);
      item = { base: b2, id: pre + b2, rect: r, aliases: [],
               label: pl + (key === 'архив' ? ` (${floor} эт.)` : ''), title: cap(pl), key };
    }
    items.push(item);
    used.add(item.id);
  }

  const wingX = east ? east[0] : Infinity;
  for (const it of items) {
    const r = it.rect;
    const center = [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2];
    // комнаты восточного крыла крепим только к его коридору E (иначе их может утянуть к лестнице-проходу)
    const only = cfg.overrides[it.base] || (center[0] >= wingX ? 'E' : undefined);
    const b = project(center, only);
    const door = clampToRect(b.p, r);                 // дверь — точка стенки комнаты, ближайшая к коридору
    const extra = { type: 'room', label: it.label, aliases: it.aliases, cx: Math.round(center[0] * 10) / 10, cy: Math.round(center[1] * 10) / 10,
                    rect: [r[0], r[1], r[2] - r[0], r[3] - r[1]] };
    if (it.num) extra.num = it.num;
    if (it.title) extra.title = it.title;
    if (it.key) extra.key = it.key;
    addNode(it.id, door[0], door[1], extra);
    attach(it.id, door, only);
  }

  // ---------- лестницы ----------
  const links = {};
  const stairRect = (x, y) => {
    const c = svg.rooms.filter(r => inside(r, x, y));
    const r = c.length ? c.reduce((a, b) => (area(a) <= area(b) ? a : b)) : null;
    return r ? [r[0], r[1], r[2] - r[0], r[3] - r[1]] : undefined;
  };
  for (const [key, { x, y }] of Object.entries(stairs)) {
    const extra = { type: 'stairs', label: `лестница: ${DESC[key]} (${floor} эт.)`, short: DESC[key], aliases: [], title: 'Лестница', rect: stairRect(x, y) };
    if (key === 'wing_pass') {
      const pid = verts.get(`${x},${y}`);              // лестница на проходе в восточное крыло (уже вершина коридора)
      if (!pid) throw new Error(`${floor} этаж: коридоры W/D должны начинаться в лестнице-проходе (${x},${y})`);
      Object.assign(nodes[pid], extra);
      links[key] = pid;
    } else {
      const sid = `${pre}st_${key}`;
      addNode(sid, x, y, extra);
      attach(sid, [x, y], (cfg.stairOverrides || {})[key]);
      links[key] = sid;
    }
  }

  // ---------- вход ----------
  if (cfg.entrance) {
    const [x, y, stairKey] = cfg.entrance;
    const eid = `${pre}entr_main`;
    addNode(eid, x, y, { type: 'entrance', label: 'Главный вход', aliases: ['вход'], title: 'Главный вход' });
    edges.push([eid, links[stairKey]]);
  }

  // ---------- цепочки коридоров ----------
  for (const s of segments) {
    s.items.sort((a, b) => a[0] - b[0]);
    const chain = [s.a, ...s.items.map(i => i[1]), s.b];
    for (let i = 0; i + 1 < chain.length; i++) edges.push([chain[i], chain[i + 1]]);
  }

  const unlabeled = svg.rooms.filter(r => !rectTexts.get(r).length && (r[2] - r[0] > 27 || r[3] - r[1] > 27) &&
                                          !Object.values(stairs).some(s => inside(r, s.x, s.y)));
  // границы плана и стартовый вид (главный коридор) — чтобы карту нельзя было утащить в пустоту
  const all = [...svg.grays, ...svg.rooms];
  const bbox = [Math.min(...all.map(r => r[0])) - 30, Math.min(...all.map(r => r[1])) - 30,
                Math.max(...all.map(r => r[2])) + 30, Math.max(...all.map(r => r[3])) + 30].map(Math.round);
  const home = { x: Math.max(bbox[0], Math.round(main[0] - 40)), y: Math.round(main[1] - 110), w: Math.min(1400, bbox[2] - bbox[0]) };
  return { links, unlabeled, nRooms: items.length, bbox, home };
}

// ---------------------------------------------------------------- main
function main() {
  const nodes = {}, edges = [], allLinks = {}, metaFloors = {};
  for (const [f, cfg] of Object.entries(FLOORS)) {
    const floor = +f;
    const svg = parseSvg(cfg.svg);
    const res = buildFloor(floor, cfg, nodes, edges, svg);
    allLinks[floor] = res.links;
    metaFloors[floor] = { svg: cfg.svg, name: `${floor} этаж`, w: svg.w, h: svg.h, bbox: res.bbox, home: res.home };
    console.log(`${floor} этаж: помещений ${res.nRooms}, лестниц ${Object.keys(res.links).length}, прямоугольников без подписи: ${res.unlabeled.length}`);
    for (const r of res.unlabeled) console.log('      ', JSON.stringify(r));
  }

  // связь этажей: одноимённые лестницы
  const floors = Object.keys(FLOORS).map(Number).sort((a, b) => a - b);
  for (let i = 0; i + 1 < floors.length; i++) {
    const lo = floors[i], hi = floors[i + 1];
    for (const key of Object.keys(allLinks[lo])) {
      if (BLOCKED_LINKS.has(`${lo}:${key}`)) { console.log(`   лестница ${key}: ${lo} ↔ ${hi} ЗАКРЫТА`); continue; }
      if (allLinks[hi][key]) {
        edges.push([allLinks[lo][key], allLinks[hi][key], FLOOR_COST]);
        console.log(`   лестница ${key}: ${lo} ↔ ${hi}`);
      }
    }
  }

  const seen = new Set(), clean = [];
  for (const e of edges) {
    const [a, b] = e, k = [a, b].sort().join('|');
    if (a !== b && !seen.has(k) && nodes[a] && nodes[b]) { seen.add(k); clean.push(e); }
  }

  const meta = { floorCost: FLOOR_COST, floors: metaFloors };
  fs.writeFileSync(path.join(DIR, 'graph.json'), JSON.stringify({ meta, nodes, edges: clean }, null, 1), 'utf8');
  console.log(`итого: узлов ${Object.keys(nodes).length}, рёбер ${clean.length} -> graph.json`);
}

main();
