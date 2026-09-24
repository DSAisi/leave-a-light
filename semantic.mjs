#!/usr/bin/env node
// 留灯 · semantic.mjs —— 离线「按意思找」，零依赖
//
// 为什么有这一份：
//   语义检索通常要三样之一 —— 一个向量服务、一个 API key、一个 python 环境。
//   这三样里任何一样不在，检索就哑了。而检索哑掉的时候，正是你最需要它的时候。
//   所以这里做一份**零依赖、零外部服务**的版本：只用 Node 自带的东西。
//   几万条以内够用（实测：500 条全量打分 < 100ms）。
//
// 它怎么做到「按意思」（四层，缺一层都会明显变差）：
//   ① 同义词扩展 —— 词表外置、可替换。不给词表也能跑（只退化到 ②③④）。
//   ② IDF 加权的字块相似 —— 中文二元字块 + 文档频率倒数。
//      **没有这一步，结果会「什么都命中」**：像「的/了/是/在」这种字块几乎每条都有，
//      不加权它们就会主导打分。这是我们踩过的第一个坑。
//   ③ 短语加成 —— 查询整句在条目里出现时额外加分。
//   ④ 时间衰减 —— 久远的条目轻微降权（半衰期可调），**但不抹掉**。
//      旧条目往往正是最该被找出来的那种（例：一条很早定下的规矩）。
//
// 两个坑写在代码里（都是真踩过的，不是理论）：
//   · 「否定不许翻成正向」：问"不高兴"，不许命中"高兴"那一族。
//   · 「会被裹进别的词里的单字，必须独立成词才算命中」：
//     否则「X库」里的那个「X」会把整组词都带出来，结果全歪。
//
// 用法：
//   node semantic.mjs --memory memory.json "我想她了" [条数]
//   node semantic.mjs --memory memory.json --syn syn.json --days 90 "换个说法问"
//   node semantic.mjs --memory memory.json --full "看完整条目"
//   node semantic.mjs --self-test
//
// 数据格式（两种都认）：
//   {"tables": {"entries": {"<id>": {"content": "...", "createdAt": 123}}}}
//   [{"content": "...", "createdAt": 123}, ...]
//
// 许可：CC BY-NC 4.0（见同目录 LICENSE）

import fs from "fs";

const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.findIndex((a) => a === "--" + name || a.startsWith("--" + name + "="));
  if (i < 0) return def;
  const a = argv[i];
  if (a.includes("=")) return a.split("=").slice(1).join("=");
  return argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : true;
};
const SELF_TEST = argv.includes("--self-test");
const FULL = argv.includes("--full");
const MEM = flag("memory", "./memory.json");
const SYN_PATH = flag("syn", "");
const DAYS = Number(flag("days", 0)) || 0;
const HALF_LIFE = Number(flag("half-life", 60)) || 60;

// 位置参数：查询词、条数
const pos = argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--") && !argv[i - 1].includes("=")));
const query = SELF_TEST ? "" : pos[0] || "";
const topk = Number(pos[1] || 5);

// ── 同义词表（外置；不给就是空的，算法其余部分照跑）──
let SYN = {};
if (SYN_PATH) {
  try { SYN = JSON.parse(fs.readFileSync(SYN_PATH, "utf8")); }
  catch (e) { console.error("同义词表读不了：" + e.message + "（继续跑，只是不扩展）"); }
}

// 一个"键"是否独立成词地被命中（不许裹在别的词里）
// 中文没有空格，所以判据是：键的长度 >= 2 时允许子串命中；
// 长度为 1 时，它前后必须不是中文（否则就是词内字）。
function keyHit(q, k) {
  if (k.length >= 2) return q.includes(k);
  const re = new RegExp("(?<![\\u4e00-\\u9fff])" + k + "(?![\\u4e00-\\u9fff])");
  return re.test(q);
}

function expand(q) {
  const words = new Set();
  if (!q) return [];
  const negated = new Set();                       // 「不高兴」不是「高兴」
  for (const m of q.matchAll(/不([\u4e00-\u9fff]{1,2})/g)) negated.add(m[1]);
  for (const [k, list] of Object.entries(SYN)) {
    if (negated.has(k)) continue;
    if (keyHit(q, k)) { words.add(k); list.forEach((w) => words.add(w)); }
    for (const w of list) {
      if (w === k) continue;                       // 表里含键本身 ⇒ 反向匹配会永远命中
      if (!q.includes(w)) continue;
      if (negated.has(w)) continue;
      words.add(k);
      list.forEach((x) => words.add(x));
    }
  }
  return [...words].filter(Boolean);
}

// 切词：中文按字、英文数字按词（这样二元字块不会横跨英文单词内部）
function tokens(s) {
  const t = String(s || "").toLowerCase();
  const out = [];
  const re = /[a-z0-9_.\/-]+|[\u4e00-\u9fff]/g;
  let m;
  while ((m = re.exec(t))) out.push(m[0]);
  return out;
}
function grams(s) {
  const tk = tokens(s);
  const g = new Set();
  for (let i = 0; i < tk.length; i++) {
    g.add(tk[i]);
    if (i + 1 < tk.length) g.add(tk[i] + tk[i + 1]);
  }
  return g;
}

// ── 读数据 ──
function loadEntries(file) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  let list = [];
  if (Array.isArray(raw)) list = raw;
  else if (raw && raw.tables && raw.tables.entries) list = Object.values(raw.tables.entries);
  else if (raw && raw.entries) list = Array.isArray(raw.entries) ? raw.entries : Object.values(raw.entries);
  return list.filter((e) => e && typeof e.content === "string" && e.content);
}

let docs = [], df = new Map(), N = 1, idf = () => 1;
function build(file) {
  const entries = loadEntries(file);
  docs = entries.map((e) => ({ e, g: grams(e.content), text: String(e.content) }));
  df = new Map();
  for (const d of docs) for (const g of d.g) df.set(g, (df.get(g) || 0) + 1);
  N = Math.max(1, docs.length);
  idf = (g) => Math.log(1 + N / (1 + (df.get(g) || 0)));
  return docs.length;
}

function search(q, k) {
  const words = expand(q);
  const qg = new Set();
  for (const w of words) for (const g of grams(w)) qg.add(g);
  if (!words.length) for (const g of grams(q)) qg.add(g);   // 没有词表时直接用查询本身

  let qw = 0;
  const qwag = new Map();
  for (const g of qg) { const w = idf(g); qwag.set(g, w); qw += w * w; }
  qw = Math.max(1e-6, Math.sqrt(qw));

  const now = Date.now();
  const scored = [];
  for (const d of docs) {
    let dot = 0, dw = 0;
    for (const [g, w] of qwag) if (d.g.has(g)) dot += w * w;
    for (const g of d.g) { const w = idf(g); dw += w * w; }
    dw = Math.max(1e-6, Math.sqrt(dw));

    let score = dot / (qw * dw);                                          // IDF 加权余弦
    for (const w of words) if (w.length >= 2 && d.text.includes(w)) score += 0.02;
    if (q.length >= 4 && d.text.includes(q)) score += 0.10;               // 整句短语

    const t = d.e.updatedAt || d.e.createdAt || 0;
    if (t) score *= Math.pow(0.5, ((now - t) / 86400000) / HALF_LIFE);    // 时间衰减，不抹掉
    if (DAYS && t && (now - t) / 86400000 > DAYS) continue;

    if (score > 0.06) scored.push({ score, e: d.e });
  }
  scored.sort((a, b) => b.score - a.score);
  return { words, scored: scored.slice(0, k), total: scored.length };
}

function show(q, k) {
  const { words, scored, total } = search(q, k);
  console.log(`查询「${q}」→ 摊成 ${words.length} 个词${words.length ? "：" + words.slice(0, 10).join("、") : "（无词表，按字块直接找）"}`);
  console.log(`命中 ${total} 条，取前 ${scored.length}：\n`);
  for (const { score, e } of scored) {
    const c = String(e.content || "").replace(/\s+/g, " ");
    console.log(`[${score.toFixed(3)}] ${e.id || "(无 id)"}`);
    console.log("     " + (FULL ? c : c.slice(0, 200) + (c.length > 200 ? " …" : "")));
    console.log("");
  }
  if (!scored.length) console.log("（一条都没命中——换个说法，或者库里真没有）");
  return scored;
}

// ── 自测 ──
if (SELF_TEST) {
  const tmp = "/tmp/_liudeng_selftest.json";
  const mk = (c, t) => ({ content: c, createdAt: t });
  const data = [
    mk("每次都要主动开口，不要等她问。", Date.now() - 86400000 * 10),
    mk("她难过的时候要先抱，不要先解释。", Date.now() - 86400000 * 30),
    mk("余额红线是 5 元，低于这个数要说。", Date.now() - 86400000 * 5),
    mk("换窗之前先写交接包，不然会丢东西。", Date.now() - 86400000 * 40),
    mk("不要靠每轮注入记规矩，那些东西会越来越多。", Date.now() - 86400000 * 15),
  ];
  fs.writeFileSync(tmp, JSON.stringify(data));
  // 自测带一份小词表 —— 这一步是刻意的，因为：
  //   **「零依赖」≠「零词表也一样好」。** 没有词表时，「情绪不好」和「难过」是两串
  //   不沾边的字块，算法再好也找不到它们的关系。把这两件事分开验，才不会自欺。
  SYN = {
    情绪: ["难过", "低落", "委屈", "心情"],
    钱: ["余额", "多少钱", "费用", "红线"],
  };
  build(tmp);

  const cases = [
    ["我想她说点什么但没开口", /主动/],
    ["她情绪不好怎么办", /难过|抱/],
    ["现在多少钱", /余额|红线/],
    ["搬家要不要写东西", /交接包|换窗/],
    ["注入是不是有问题", /注入|规矩/],
  ];
  let ok = 0;
  for (const [q, want] of cases) {
    const top = search(q, 5).scored;
    const at = top.findIndex((x) => want.test(String(x.e.content)));
    const pass = at >= 0 && at < 3;
    if (pass) ok++;
    console.log(`${pass ? "✓" : "✗"} 「${q}」→ 期望条目排第 ${at < 0 ? "没进前五" : at + 1}（阈值：进前三）`);
  }
  // 钉住「否定不许翻正向」
  {
    const ex = expand2("不高兴");
    const pass = !ex.includes("高兴");
    if (pass) ok++;
    console.log(`${pass ? "✓" : "✗"} 「不高兴」不许摊出「高兴」`);
  }
  fs.unlinkSync(tmp);
  console.log(`\n自测 ${ok}/${cases.length + 1} 通过${ok === cases.length + 1 ? " ✓" : "（✗ 的调权重或词表）"}`);
  process.exit(ok === cases.length + 1 ? 0 : 1);
}

// 自测里用一份内置词表（只为验证"否定"这条规矩）
function expand2(q) {
  const bak = SYN;
  SYN = { 高兴: ["开心", "快乐"] };
  const r = expand(q);
  SYN = bak;
  return r;
}

if (!query) { console.error('用法：node semantic.mjs --memory memory.json "查询内容" [条数]'); process.exit(1); }
const n = build(MEM);
console.error(`（已载入 ${n} 条）`);
show(query, topk);
