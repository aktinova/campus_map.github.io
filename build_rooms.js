#!/usr/bin/env node
/*
 * build_rooms.js — превращает rooms.txt (описания помещений) в rooms.json для подсказок на карте.
 *
 * Запуск:   node build_rooms.js          (только Node.js, пакеты не нужны)
 * Формат rooms.txt описан в его начале. Номера, которых в списке нет, на карте будут «Учебная аудитория».
 */
'use strict';
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const txt = fs.readFileSync(path.join(DIR, 'rooms.txt'), 'utf8').replace(/\r/g, '');

const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const norm = s => s.toLowerCase().replace(/a/g, 'а');            // латинская «a» в номере → русская «а»
const quotes = s => s.replace(/"([^"]*)"/g, '«$1»');
const tidy = s => quotes(s.replace(/\s+/g, ' ').trim());

const NAME = /([А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)?\s+[А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+)/;      // Фамилия Имя Отчество
const ROLE_WORD = /^(Заместитель|Специалист|Помощник|Начальник|Руководитель|Декан|Заведующ|Директор|Проректор|Ученый секретарь)/i;
const HOURS_HEAD = /^(режим работы|часы работы)\s*:?$/i;
const HOURS_LINE = /^(понедельник|вторник|среда|четверг|пятница|суббота|воскресенье|обед|пн|вт|ср|чт|пт)(?![а-яё])/i;
const HOURS_NOTE = /^(прием|приём)/i;
const NUMS = String.raw`\d+\s*[а-яa-z]?`;
const HEAD = new RegExp(`^\\s*(${NUMS}(?:\\s*,\\s*${NUMS})*)\\s*[-–—]\\s*(.*)$`, 'i');       // «336, 337 - название»
const HEAD_NAMED = /^@(.+?)\s+-\s+(.*)$/;                                                   // «@архив - Архив»
const FLOOR = /^(\d)\s*этаж\s*$/i;

// ---- 1. режем файл на записи
const entries = [];
let floor = null, cur = null;
for (const raw of txt.split('\n')) {
  const line = raw.trim();
  if (line.startsWith('#')) continue;
  let m;
  if ((m = FLOOR.exec(line))) { floor = +m[1]; cur = null; continue; }
  if ((m = HEAD_NAMED.exec(line))) { cur = { keys: [`${floor}:${norm(m[1].trim())}`], lines: [m[2]] }; entries.push(cur); continue; }
  if ((m = HEAD.exec(line))) {
    cur = { keys: m[1].split(',').map(x => norm(x.replace(/\s+/g, ''))), lines: [m[2]] };
    entries.push(cur);
    continue;
  }
  if (cur) cur.lines.push(line);
}

// ---- 2. строки записи -> заголовок и блоки
const NAME_END = new RegExp(NAME.source + String.raw`\s*$`);                          // ФИО в конце строки
const NAME_START = new RegExp('^' + NAME.source + String.raw`\s+(.+)$`);               // ФИО в начале, дальше описание
const DEGREE = /(^|\s)(к\.|д\.|ph\.d|доктор|кандидат)/i;

function person(ln) {
  // «должность ФИО» | «степень ФИО» | «ФИО описание» | только «ФИО» → { role, deg, name } или null
  ln = ln.replace(/\s+[-–—]\s+/g, ' ');
  let m = NAME_END.exec(ln);
  if (m) {
    const name = m[1], before = ln.slice(0, m.index).replace(/[,\s]+$/, '');
    const d = DEGREE.exec(before);
    if (!d) return /^(к\.|д\.|ph\.d|доктор|кандидат)/i.test(before) ? { role: '', deg: before, name } : { role: before, deg: '', name };
    const at = d.index + d[1].length;
    return { role: before.slice(0, at).trim(), deg: before.slice(at).trim(), name };
  }
  m = NAME_START.exec(ln);
  if (m) return { role: m[2].replace(/[,\s]+$/, ''), deg: '', name: m[1] };
  return null;
}

function parse(lines) {
  let title = '';
  const blocks = [];
  let hours = null, pending = null, first = true;
  const startHours = h => { hours = { h, t: [] }; blocks.push(hours); };
  const flush = () => { if (pending) { blocks.push({ t: pending }); pending = null; } };
  for (const raw of lines) {
    const ln = tidy(raw);
    const isFirst = first && !!ln; if (ln) first = false;
    if (!ln) { hours = null; continue; }
    if (HOURS_HEAD.test(ln)) { flush(); startHours(cap(ln.replace(/\s*:$/, ''))); continue; }
    if (HOURS_LINE.test(ln)) { flush(); if (!hours) startHours('Режим работы'); hours.t.push(ln.replace(/\s+-\s+/g, ' – ')); continue; }
    if (hours && HOURS_NOTE.test(ln)) { hours.t.push(cap(ln)); continue; }
    hours = null;
    // несколько человек в одной строке: «…Иванов И. И., Заместитель Декана - … Петров П. П.»
    const parts = NAME_END.test(ln) ? ln.split(/,\s*(?=(?:Заместитель|Секретарь|Помощник)(?![а-яё]))/) : [ln];
    for (const part of parts) {
      const p = person(part);
      if (p) {
        let h = p.role, t = p.deg ? `${p.deg} ${p.name}` : p.name;
        if (!h && pending) h = pending;                                  // должность была строкой выше
        else flush();
        pending = null;
        if (!h && p.deg) { h = p.deg; t = p.name; }                      // «доктор наук, профессор ФИО» → степень золотым
        blocks.push(h ? { h: cap(h), t } : { t });
      } else if (isFirst) {
        if (/,\s*(Начальник|Заведующ|Заместитель)/.test(ln)) for (const x of ln.split(/,\s*(?=[А-ЯЁ])/)) blocks.push({ t: cap(x) });   // перечень должностей
        else title = cap(ln);
      } else if (ROLE_WORD.test(ln) && ln.length < 90) { flush(); pending = ln; }
      else { flush(); blocks.push({ t: ln }); }
    }
  }
  flush();
  return { title, blocks };
}

const rooms = {};
for (const e of entries) {
  const info = parse(e.lines);
  const out = { title: info.title };
  if (info.blocks.length) out.blocks = info.blocks;
  for (const k of e.keys) {
    if (k in rooms && JSON.stringify(rooms[k]) !== JSON.stringify(out)) console.warn(`   ! «${k}» описано дважды, берём последнее`);
    rooms[k] = out;
  }
}

// ---- 3. все ли номера из списка есть на планах
try {
  const g = JSON.parse(fs.readFileSync(path.join(DIR, 'graph.json'), 'utf8')).nodes;
  const nodes = Object.values(g);
  for (const k of Object.keys(rooms)) {
    const [f, key] = k.includes(':') ? k.split(':') : [null, k];
    const found = nodes.some(n => f ? (n.key === key && String(n.floor) === f) : n.num === key);
    if (!found) console.warn(`   ! «${k}» из списка не найдено на плане`);
  }
} catch (e) { /* graph.json ещё не собран — пропускаем проверку */ }

fs.writeFileSync(path.join(DIR, 'rooms.json'), JSON.stringify(rooms, null, 1), 'utf8');
console.log(`описаний помещений: ${Object.keys(rooms).length} -> rooms.json`);
