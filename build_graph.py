"""Разбирает floor1.svg и floor2.svg и собирает один graph.json на оба этажа.

Запуск:  python build_graph.py
Нужен только Python 3, внешних библиотек нет.

Идея: коридоры каждого этажа заданы вручную (ломаные по центру серых зон),
а двери, лестницы и сервисные точки привязываются к ближайшему коридору автоматически.
Этажи связываются рёбрами между одноимёнными лестницами.
"""
import json
import math
import re
import xml.etree.ElementTree as ET

T = "{http://www.w3.org/2000/svg}"
ROOM_FILLS = ("#975102", "#50804C")   # коричневые и зелёные прямоугольники — помещения

# «Стоимость» подъёма/спуска на один этаж в пикселях плана (300 px = 15 м при 20 px/м).
# Чем больше число, тем неохотнее маршрут меняет этаж.
FLOOR_COST = 300

# Лестницы, по которым между этажами НЕ пройти: (нижний этаж, ключ лестницы).
# Главная лестница в подвал (1 этаж) закрыта — двери заперты.
BLOCKED_LINKS = {(1, "mid_s")}

FLOORS = {
    # Нумерация этажей: floor0.svg = 1 этаж, floor1.svg = 2 этаж, floor2.svg = 3 этаж, floor3.svg = 4 этаж.
    1: {
        "svg": "floor0.svg",
        "corridors": {
            "B": [(40, 948), (249, 948), (249, 928), (1121, 928)],      # главный коридор
            "A": [(249, 948), (249, 1470)],                             # левый вертикальный
            "C": [(1121, 928), (1121, 940), (1121, 1470)],              # правый вертикальный
            # участка D нет: в восточное крыло 1 этажа попадают только по лестнице со 2 этажа
            "W": [(1548, 940), (1620, 940)],                            # от восточной лестницы к крылу
            "E": [(1620, 247), (1620, 940), (1620, 1000)],              # крыло, комнаты по обе стороны
        },
        "stairs": {
            "mid_s": (651, 990, "центр (юг)"),
            "left_n": (320, 989, "левая (север)"),
            "left_s": (317, 1377, "левая (юг)"),
            "right_n": (1052, 989, "правая (север)"),
            "right_s": (1049, 1377, "правая (юг)"),
            "wing_n": (1543, 264, "восточное крыло (север)"),
        },
        "passage": (1548, 940),
        "entrance": None,
        "overrides": {},
    },
    2: {
        "svg": "floor1.svg",
        "corridors": {
            "B": [(40, 948), (249, 948), (249, 928), (1121, 928)],      # главный коридор
            "A": [(249, 948), (249, 1470)],                             # левый вертикальный
            "C": [(1121, 928), (1121, 940), (1121, 1470)],              # правый вертикальный
            "D": [(1121, 940), (1506, 940)],                            # к восточному крылу
            "W": [(1506, 940), (1548, 940), (1620, 940)],               # проход через лестницу в крыло
            "E": [(1620, 247), (1620, 940), (1620, 985)],               # восточное крыло
        },
        # ключ: (x, y, описание). Одноимённые ключи на разных этажах соединяются между собой.
        "stairs": {
            "mid_n": (651, 868, "центр (север)"),
            "mid_s": (651, 990, "центр (у входа)"),
            "left_n": (320, 989, "левая (север)"),
            "left_s": (317, 1377, "левая (юг)"),
            "right_n": (1052, 989, "правая (север)"),
            "right_s": (1049, 1377, "правая (юг)"),
            "wing_n": (1543, 264, "восточное крыло (север)"),
        },
        "passage": (1548, 940),                  # лестница «wing_pass» — стоит на пути D → крыло
        "entrance": (651, 1038, "mid_s"),        # вход и лестница, через которую он соединён с коридором
        "overrides": {"lab": "E", "a263a": "E", "a263": "E"},
    },
    3: {
        "svg": "floor2.svg",
        "corridors": {
            # слева комната 318 занимает весь конец коридора, справа комната 335 перекрывает путь на восток,
            # поэтому на 3 этаже нет ни левого края B, ни участка D (красная черта на плане).
            "B": [(249, 948), (249, 928), (1121, 928)],
            "A": [(249, 948), (249, 1470)],
            "C": [(1121, 928), (1121, 1470)],
            "W": [(1548, 940), (1620, 940)],
            "E": [(1620, 247), (1620, 940), (1620, 985)],
        },
        "stairs": {
            "mid_n": (651, 868, "центр (север)"),
            "left_n": (320, 989, "левая (север)"),
            "left_s": (317, 1377, "левая (юг)"),
            "right_n": (1052, 989, "правая (север)"),
            "right_s": (1050, 1385, "правая (юг)"),
            "wing_n": (1543, 264, "восточное крыло (север)"),
        },
        "passage": (1548, 940),
        "entrance": None,
        "overrides": {},
    },
    4: {
        "svg": "floor3.svg",
        "corridors": {
            # восточного крыла нет. Главный коридор упирается в музей (его дверь на плане слева),
            # поэтому B кончается у x=1064. Правый коридор C начинается в тамбуре за правой лестницей.
            "B": [(249, 928), (1064, 928)],
            "A": [(249, 928), (249, 1400)],       # внизу его перекрывает комната 401
            "C": [(1121, 996), (1121, 1403)],     # внизу его перекрывает комната 448
        },
        "stairs": {
            "left_n": (320, 989, "левая (север)"),
            "left_s": (317, 1377, "левая (юг)"),
            "right_n": (1052, 989, "правая (север)"),
            "right_s": (1050, 1385, "правая (юг)"),
        },
        # стрелки выхода на плане: левая лестница выходит влево (в коридор A),
        # правая — вправо (в тамбур коридора C); красная черта закрывает её верхнюю дверь в коридор B
        "stair_overrides": {"left_n": "A", "right_n": "C"},
        "passage": None,
        "entrance": None,
        "overrides": {"museum": "B"},
        # музей — не проход: входить в него можно только со стороны главного коридора B.
        # Если нужен сквозной проход, добавьте сюда:
        # "extra_doors": [{"room": "museum", "door": (1156.5, 1005), "corridor": "C"}],
        # на 4 этаже это не помещения, а пустота над двусветными залами 3 этажа
        "skip_text": ["актовый зал 2 эт", "спортивный зал 2 эт"],
    },
}

RECT_RE = re.compile(r"M([\d.]+) ([\d.]+)H([\d.]+)V([\d.]+)H([\d.]+)V([\d.]+)Z")
NUM_RE = re.compile(r"\d+[a-zа-я]?")
TRANSLIT = {"а": "a", "б": "b", "в": "v"}
NAMED = {
    "столовая": "canteen", "касса": "cashier", "лаборатория": "lab",
    "цит": "cit", "директор цита": "cit_director",
    "актовый зал": "assembly_hall", "спортивный зал": "gym", "архив": "archive", "музей": "museum",
    "библиотека": "library", "гардероб": "cloakroom", "дирек тор библи отеки": "library_director",
}
# подписи, которые в SVG разорваны на слоги («дирек / тор / библи / отеки»)
LABELS = {"дирек тор библи отеки": "директор библиотеки"}


def pretty_label(names, key):
    if key in LABELS:
        return LABELS[key]
    txt = " ".join(names)
    return txt.lower() if txt.isupper() and len(txt) > 4 else txt   # «БИБЛИОТЕКА» → «библиотека», но «ЦИТ» остаётся


def tr(s):
    return "".join(TRANSLIT.get(c, c) for c in s.lower())


def parse_rects(root):
    out = []
    for p in root.iter(T + "path"):
        if p.get("fill") not in ROOM_FILLS:
            continue
        m = RECT_RE.fullmatch(p.get("d", "").strip())
        if m:
            out.append((float(m[1]), float(m[2]), float(m[3]), float(m[4])))
    return out


def parse_texts(root):
    out = []
    for t in root.iter(T + "text"):
        lines, x0, y0 = [], None, None
        for ts in t.iter(T + "tspan"):
            if x0 is None:
                x0, y0 = float(ts.get("x")), float(ts.get("y"))
            s = (ts.text or "").strip()
            if s:
                lines.append(s)
        if lines:
            out.append({"lines": lines, "x": x0, "y": y0})
    return out


def parse_icons(root):
    """Чёрные/белые иконки: (цвет, x, y начала контура). Белая фигурка = мужской туалет, чёрная = женский."""
    out = []
    for p in root.iter(T + "path"):
        f = p.get("fill")
        m = re.match(r"M([\d.]+) ([\d.]+)", p.get("d", ""))
        if f in ("white", "black") and m:
            out.append((f, float(m[1]), float(m[2])))
    return out


def area(r):
    return (r[2] - r[0]) * (r[3] - r[1])


def clamp_to_rect(p, r):
    return (min(max(p[0], r[0]), r[2]), min(max(p[1], r[1]), r[3]))


def svg_size(path):
    root = ET.parse(path).getroot()
    return int(float(root.get("width"))), int(float(root.get("height")))


def build_floor(floor, cfg, nodes, edges):
    pre = f"f{floor}_"
    root = ET.parse(cfg["svg"]).getroot()
    rects, texts, icons = parse_rects(root), parse_texts(root), parse_icons(root)

    # текст -> самый маленький прямоугольник, который его содержит
    rect_texts = {r: [] for r in rects}
    for tx in texts:
        cands = [r for r in rects if r[0] - 3 <= tx["x"] <= r[2] and r[1] <= tx["y"] <= r[3] + 2]
        if cands:
            rect_texts[min(cands, key=area)].append(tx)

    def add_node(nid, x, y, **kw):
        nodes[nid] = {"floor": floor, "x": round(x, 1), "y": round(y, 1), **kw}

    # вершины коридоров (одинаковые координаты склеиваются)
    verts = {}

    def cv(x, y):
        if (x, y) not in verts:
            nid = f"{pre}c{len(verts)}"
            verts[(x, y)] = nid
            add_node(nid, x, y, type="corridor")
        return verts[(x, y)]

    segments = []
    for cname, poly in cfg["corridors"].items():
        for p, q in zip(poly, poly[1:]):
            segments.append({"p": p, "q": q, "a": cv(*p), "b": cv(*q), "items": [], "name": cname})

    def project(pt, only=None):
        best = None
        for si, s in enumerate(segments):
            if s["name"] == "W" or (only and s["name"] != only):
                continue                      # W — только для маршрута, двери к нему не крепим
            (ax, ay), (bx, by) = s["p"], s["q"]
            dx, dy = bx - ax, by - ay
            L2 = dx * dx + dy * dy
            t = max(0, min(1, ((pt[0] - ax) * dx + (pt[1] - ay) * dy) / L2))
            px, py = ax + t * dx, ay + t * dy
            d = math.hypot(pt[0] - px, pt[1] - py)
            if best is None or d < best[0]:
                best = (d, (px, py), si, t)
        return best

    def attach(nid, pt, only=None):
        d, p, si, t = project(pt, only)
        pid = f"{pre}p_{nid}"
        add_node(pid, p[0], p[1], type="corridor")
        segments[si]["items"].append((t, pid))
        edges.append([nid, pid])

    # ---------- помещения ----------
    items, used, wc = [], set(), {"m": 0, "f": 0}
    for r, tl in rect_texts.items():
        w, h = r[2] - r[0], r[3] - r[1]
        if not tl:
            if w <= 27 and h <= 27:           # маленькие квадраты с иконкой (принтер / кофе)
                kind = "printer" if r[0] < 650 else "coffee"
                items.append({"base": kind, "id": pre + kind, "rect": r, "aliases": [],
                              "label": "принтер" if kind == "printer" else "кофе-аппарат"})
            continue
        tl.sort(key=lambda t: t["y"])
        words = [x for t in tl for x in t["lines"]]
        if " ".join(words).lower() in cfg.get("skip_text", ()):
            continue
        nums = [x for x in words if NUM_RE.fullmatch(x)]
        names = [x for x in words if not NUM_RE.fullmatch(x)]
        cx = (r[0] + r[2]) / 2
        if names and names[0].lower() == "туалет":
            sex = None
            for f_, ix, iy in icons:
                if r[0] <= ix <= r[2] and r[1] <= iy <= r[3]:
                    sex = "m" if f_ == "white" else "f"
                    break
            if sex is None:
                sex = "m" if 700 < cx < 1400 else "f"
            wc[sex] += 1
            items.append({"base": f"wc_{sex}_{wc[sex]}", "id": f"{pre}wc_{sex}_{wc[sex]}", "rect": r, "aliases": [],
                          "label": f"туалет ({'муж.' if sex == 'm' else 'жен.'}) {wc[sex]}, {floor} эт."})
        elif nums:
            base = "a" + tr(nums[0])
            nid = base if base not in nodes and base not in used else f"{base}_{floor}"
            items.append({"base": base, "id": nid, "rect": r,
                          "aliases": sorted({nums[0].lower(), tr(nums[0])}),
                          "label": " ".join([nums[0]] + names)})
        else:
            key = " ".join(names).lower()
            base = NAMED.get(key, "room")
            b2, k = base, 2
            while pre + b2 in used:
                b2, k = f"{base}_{k}", k + 1
            items.append({"base": b2, "id": pre + b2, "rect": r, "aliases": [],
                          "label": pretty_label(names, key) + (f" ({floor} эт.)" if key in ("архив",) else "")})
        used.add(items[-1]["id"])

    for it in items:
        r = it["rect"]
        only = cfg["overrides"].get(it["base"])
        center = ((r[0] + r[2]) / 2, (r[1] + r[3]) / 2)
        d, p, si, t = project(center, only)
        door = clamp_to_rect(p, r)            # дверь — точка стенки комнаты, ближайшая к коридору
        add_node(it["id"], door[0], door[1], type="room", label=it["label"], aliases=it["aliases"],
                 cx=round(center[0], 1), cy=round(center[1], 1))
        attach(it["id"], door, only)

    # ---------- лестницы ----------
    links = {}
    for key, (x, y, desc) in cfg["stairs"].items():
        sid = f"{pre}st_{key}"
        add_node(sid, x, y, type="stairs", label=f"лестница: {desc} ({floor} эт.)", short=desc, aliases=[])
        attach(sid, (x, y), cfg.get("stair_overrides", {}).get(key))
        links[key] = sid

    if cfg.get("passage"):
        pid = verts[cfg["passage"]]           # лестница на проходе в восточное крыло (уже вершина коридора)
        nodes[pid].update(type="stairs", label=f"лестница: восточная ({floor} эт.)",
                          short="восточная (в крыле)", aliases=[])
        links["wing_pass"] = pid

    # ---------- вторые двери помещений ----------
    for ex in cfg.get("extra_doors", []):
        room_id = pre + ex["room"]
        dx, dy = ex["door"]
        did = f"{pre}door_{ex['room']}_2"
        add_node(did, dx, dy, type="corridor")
        edges.append([room_id, did])
        attach(did, (dx, dy), ex["corridor"])

    # ---------- вход ----------
    if cfg.get("entrance"):
        x, y, stair_key = cfg["entrance"]
        eid = f"{pre}entr_main"
        add_node(eid, x, y, type="entrance", label="Главный вход", aliases=["вход"])
        edges.append([eid, links[stair_key]])

    # ---------- цепочки коридоров ----------
    for s in segments:
        s["items"].sort()
        chain = [s["a"]] + [pid_ for _, pid_ in s["items"]] + [s["b"]]
        for u, v in zip(chain, chain[1:]):
            edges.append([u, v])

    unlabeled = [r for r, tl in rect_texts.items() if not tl and (r[2] - r[0] > 27 or r[3] - r[1] > 27)]
    return links, unlabeled, len(items)


def main():
    nodes, edges, all_links = {}, [], {}
    for floor, cfg in FLOORS.items():
        links, unlabeled, n_rooms = build_floor(floor, cfg, nodes, edges)
        all_links[floor] = links
        print(f"{floor} этаж: помещений {n_rooms}, лестниц {len(links)}, прямоугольников без подписи: {len(unlabeled)}")
        for r in unlabeled:
            print("     ", r)

    # связь этажей: одноимённые лестницы
    floors = sorted(FLOORS)
    for lo, hi in zip(floors, floors[1:]):
        for key in all_links[lo]:
            if (lo, key) in BLOCKED_LINKS:
                print(f"   лестница {key}: {lo} ↔ {hi} ЗАКРЫТА")
                continue
            if key in all_links[hi]:
                edges.append([all_links[lo][key], all_links[hi][key], FLOOR_COST])
                print(f"   лестница {key}: {lo} ↔ {hi}")

    seen, clean = set(), []
    for e in edges:
        a, b = e[0], e[1]
        k = tuple(sorted((a, b)))
        if a != b and k not in seen and a in nodes and b in nodes:
            seen.add(k)
            clean.append(e)

    sizes = {f: svg_size(FLOORS[f]["svg"]) for f in floors}      # планы разной ширины (1 этаж шире)
    meta = {"viewBox": [0, 0, 1674, 1532], "floorCost": FLOOR_COST,
            "floors": {str(f): {"svg": FLOORS[f]["svg"], "name": f"{f} этаж", "w": sizes[f][0], "h": sizes[f][1]}
                       for f in floors}}
    with open("graph.json", "w", encoding="utf-8") as f:
        json.dump({"meta": meta, "nodes": nodes, "edges": clean}, f, ensure_ascii=False, indent=1)
    print(f"итого: узлов {len(nodes)}, рёбер {len(clean)}")


if __name__ == "__main__":
    main()
