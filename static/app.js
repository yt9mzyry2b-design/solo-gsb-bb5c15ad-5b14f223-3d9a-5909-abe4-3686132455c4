"use strict";

const LIST_LIMIT = 400;

const els = {
  expectedLength: document.getElementById("expectedLength"),
  fragments: document.getElementById("fragments"),
  addFrag: document.getElementById("addFrag"),
  submit: document.getElementById("submit"),
  error: document.getElementById("error"),
  resultCard: document.getElementById("resultCard"),
  loadDemoGap: document.getElementById("loadDemoGap"),
  loadDemoOk: document.getElementById("loadDemoOk"),
};

function parseOffset(text, what) {
  const t = text.trim();
  if (t === "") throw new Error(`请填写${what}`);
  let n;
  if (/^0x[0-9a-fA-F]+$/.test(t)) {
    n = parseInt(t, 16);
  } else if (/^\d+$/.test(t)) {
    n = parseInt(t, 10);
  } else {
    throw new Error(`${what} 只能是十进制或 0x 开头的十六进制整数：${t}`);
  }
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`${what} 非法：${t}`);
  }
  return n;
}

function hexByteLen(hex) {
  return hex.replace(/[\s:_-]/g, "").length / 2;
}

let fragSeq = 0;

function addFragment(offset = "", data = "") {
  fragSeq += 1;
  const row = document.createElement("div");
  row.className = "frag-row";
  row.innerHTML = `
    <input class="frag-offset" placeholder="如 12 或 0x0c" spellcheck="false" />
    <input class="frag-data" placeholder="如 48656c6c6f 或 48:65:6c" spellcheck="false" />
    <span class="col-op">
      <span class="idx"></span>
      <button type="button" class="del" title="删除该分片">✕</button>
    </span>`;
  row.querySelector(".frag-offset").value = offset;
  row.querySelector(".frag-data").value = data;
  row.querySelector(".del").addEventListener("click", () => {
    row.remove();
    refreshIndexes();
  });
  els.fragments.appendChild(row);
  refreshIndexes();
  return row;
}

function refreshIndexes() {
  els.fragments.querySelectorAll(".frag-row").forEach((row, i) => {
    row.querySelector(".idx").textContent = `#${i + 1}`;
  });
}

function loadDemo(expected, frags) {
  els.expectedLength.value = String(expected);
  els.fragments.innerHTML = "";
  frags.forEach(([off, data]) => addFragment(off, data));
  els.resultCard.hidden = true;
  els.error.hidden = true;
}

els.addFrag.addEventListener("click", () => addFragment());
els.loadDemoGap.addEventListener("click", () => {
  // 乱序到达：中部重叠异值（冲突）、尾部有缺口
  loadDemo(16, [
    ["10", "313020746f"],          // "10 to" @ [10,15)
    ["0", "48656c6c6f20576f"],     // "Hello Wo" @ [0,8)
    ["6", "5858313020746f21"],     // "XX10 to!" @ [6,14)，与上一分片在 [6,8) 异值
  ]);
});
els.loadDemoOk.addEventListener("click", () => {
  loadDemo(16, [
    // "Hello World" @ [0,11)
    ["0", "48656c6c6f20576f726c64"],
    // "d0 to!" @ [10,16)，与前一片在偏移 10 处同为 'd'，去重；乱序到达
    ["10", "643020746f21"],
  ]);
});

function showError(msg) {
  els.error.textContent = msg;
  els.error.hidden = false;
}

// 读取单次重组表单（重组与到达过程诊断共用），输入不合法时抛出 Error
function readReassemblyForm() {
  const expected = parseOffset(els.expectedLength.value, "预期字节数");
  const rows = [...els.fragments.querySelectorAll(".frag-row")];
  const fragments = [];
  rows.forEach((row, i) => {
    const offText = row.querySelector(".frag-offset").value;
    const dataText = row.querySelector(".frag-data").value;
    if (offText.trim() === "" && dataText.trim() === "") return; // 跳过完全空行
    const off = parseOffset(offText, `分片 #${i + 1} 的起始偏移`);
    const stripped = dataText.replace(/[\s:_-]/g, "");
    if (stripped === "") throw new Error(`分片 #${i + 1} 的十六进制内容为空`);
    if (stripped.length % 2 !== 0) {
      throw new Error(`分片 #${i + 1} 的十六进制长度为奇数（${stripped.length}）`);
    }
    if (!/^[0-9a-fA-F]+$/.test(stripped)) {
      throw new Error(`分片 #${i + 1} 含非法十六进制字符`);
    }
    if (off + stripped.length / 2 > expected) {
      throw new Error(
        `分片 #${i + 1}（偏移 ${off}，长度 ${stripped.length / 2}）超出预期长度 ${expected}`
      );
    }
    fragments.push({ offset: off, data: stripped });
  });
  if (fragments.length === 0) {
    throw new Error("请至少填写一个分片（起始偏移 + 十六进制内容）");
  }
  return { expected, fragments };
}

els.submit.addEventListener("click", () => {
  els.error.hidden = true;
  let expected, fragments;
  try {
    ({ expected, fragments } = readReassemblyForm());
  } catch (e) {
    showError(e.message);
    return;
  }

  els.submit.disabled = true;
  els.submit.textContent = "重组中…";
  fetch("/api/reassemble", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expected_length: expected, fragments }),
  })
    .then(async (resp) => {
      const body = await resp.json();
      if (!resp.ok) throw new Error(body.detail || `HTTP ${resp.status}`);
      render(expected, body, fragments);
    })
    .catch((e) => showError(e.message))
    .finally(() => {
      els.submit.disabled = false;
      els.submit.textContent = "重组";
    });
});

// ------------------------------ 渲染 -------------------------------------

function hexOff(n) {
  return "0x" + n.toString(16);
}

function fmtRange([s, e]) {
  const len = e - s;
  return `[${s}, ${e})  ≡  [${hexOff(s)}, ${hexOff(e)})  长度 ${len}`;
}

function fillRangeList(ul, runs, emptyText, limit) {
  ul.innerHTML = "";
  if (runs.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = emptyText;
    ul.appendChild(li);
    return;
  }
  const shown = runs.slice(0, limit);
  shown.forEach((r) => {
    const li = document.createElement("li");
    li.textContent = fmtRange(r);
    li.title = `十进制 [${r[0]}, ${r[1]})`;
    ul.appendChild(li);
  });
  if (runs.length > shown.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = `… 其余 ${runs.length - shown.length} 个区间已省略`;
    ul.appendChild(li);
  }
}

function addStat(k, v, cls) {
  const d = document.createElement("div");
  d.className = "stat";
  d.innerHTML = `<div class="k"></div><div class="v ${cls || ""}"></div>`;
  d.querySelector(".k").textContent = k;
  d.querySelector(".v").textContent = v;
  return d;
}

function renderBar(total, coverage, conflicts) {
  const bar = document.getElementById("coverageBar");
  bar.innerHTML = "";
  const hint = document.getElementById("barHint");
  if (total === 0) {
    const seg = document.createElement("div");
    seg.className = "seg gap";
    seg.style.flex = "1";
    seg.title = "预期长度为 0";
    bar.appendChild(seg);
    hint.textContent = "预期长度为 0";
    return;
  }

  const BUCKETS = 1200;
  // state: 0 缺口 1 覆盖 2 冲突（逐桶由冲突区间提升）
  const state = new Uint8Array(Math.min(total, BUCKETS));
  const buckets = state.length;
  const scale = total / buckets;

  coverage.forEach(([s, e]) => {
    const b0 = Math.floor((s * buckets) / total);
    const b1 = Math.max(b0 + 1, Math.ceil((e * buckets) / total));
    for (let b = b0; b < Math.min(b1, buckets); b++) if (state[b] < 1) state[b] = 1;
  });
  conflicts.forEach(([s, e]) => {
    const b0 = Math.floor((s * buckets) / total);
    const b1 = Math.max(b0 + 1, Math.ceil((e * buckets) / total));
    for (let b = b0; b < Math.min(b1, buckets); b++) state[b] = 2;
  });

  const names = ["缺口", "覆盖", "冲突"];
  const cls = ["gap", "covered", "conflict"];
  let i = 0;
  while (i < buckets) {
    const st = state[i];
    let j = i + 1;
    while (j < buckets && state[j] === st) j++;
    const seg = document.createElement("div");
    seg.className = `seg ${cls[st]}`;
    seg.style.flex = String(j - i);
    const offS = Math.floor(i * scale);
    const offE = Math.floor(j * scale);
    seg.title = `${names[st]}：[${offS}, ${offE})  (${hexOff(offS)} - ${hexOff(offE)})`;
    bar.appendChild(seg);
    i = j;
  }
  hint.textContent =
    buckets < total ? `共 ${buckets} 个示意桶（每桶 ≈ ${scale.toFixed(2)} 字节，悬停看范围）` : "每格 1 字节，悬停看范围";
}

function renderPreview(expected, previewHex, truncated, conflictRuns) {
  const pre = document.getElementById("preview");
  pre.innerHTML = "";
  if (expected === 0) {
    pre.textContent = "（预期长度为 0，无字节可预览）";
    return;
  }
  const bytes = new Uint8Array(previewHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(previewHex.substr(i * 2, 2), 16);
  }
  // 冲突字节集合（仅预览范围内）
  const conflictSet = new Set();
  for (const [s, e] of conflictRuns) {
    for (let p = s; p < Math.min(e, bytes.length); p++) conflictSet.add(p);
  }

  const lines = Math.ceil(bytes.length / 16);
  for (let row = 0; row < lines; row++) {
    const base = row * 16;
    const line = document.createElement("div");

    const addr = document.createElement("span");
    addr.className = "addr";
    addr.textContent = hexOff(base).padStart(8, "0");
    line.appendChild(addr);

    const hexPart = document.createElement("span");
    let ascii = "";
    for (let k = 0; k < 16; k++) {
      const pos = base + k;
      if (k === 8) hexPart.appendChild(document.createTextNode(" "));
      if (pos < bytes.length) {
        const span = document.createElement("span");
        span.textContent = bytes[pos].toString(16).padStart(2, "0");
        if (conflictSet.has(pos)) span.className = "conflict-byte";
        hexPart.appendChild(span);
        const c = bytes[pos];
        ascii += c >= 0x20 && c <= 0x7e ? String.fromCharCode(c) : ".";
      } else {
        const span = document.createElement("span");
        span.className = "gap-byte";
        span.textContent = "··";
        hexPart.appendChild(span);
        ascii += " ";
      }
      hexPart.appendChild(document.createTextNode(" "));
    }
    line.appendChild(hexPart);

    const asc = document.createElement("span");
    asc.className = "ascii";
    asc.textContent = ascii;
    line.appendChild(asc);
    pre.appendChild(line);
  }
  if (truncated) {
    const note = document.createElement("div");
    note.className = "addr";
    note.textContent = `… 仅预览前 ${bytes.length} 字节，完整内容需在可下载时获取。`;
    pre.appendChild(note);
  }
}

function render(expected, r, submitted) {
  els.resultCard.hidden = false;
  els.resultCard.scrollIntoView({ behavior: "smooth", block: "start" });

  const banner = document.getElementById("banner");
  const note = document.getElementById("downloadNote");
  const dlBtn = document.getElementById("downloadBtn");
  dlBtn.hidden = true;

  if (r.downloadable) {
    banner.className = "banner ok";
    banner.textContent = `✓ 范围完整且无冲突：${expected} 字节全部覆盖，可以下载还原的二进制。`;
  } else {
    const problems = [];
    if (!r.complete) problems.push(`存在 ${r.gaps.length} 段缺口（共 ${r.stats.gap_length} 字节）`);
    if (r.has_conflict) problems.push(`存在 ${r.conflicts.length} 段冲突（共 ${r.stats.conflict_length} 字节）`);
    banner.className = "banner bad";
    banner.textContent = "✗ 不可下载：" + problems.join("；") + "。";
  }

  // 统计
  const stats = document.getElementById("stats");
  stats.innerHTML = "";
  const s = r.stats;
  [
    ["分片数", s.fragment_count],
    ["输入字节总量", s.total_input_bytes],
    ["已覆盖字节", `${s.covered_length} / ${expected}`, r.complete ? "ok" : "warn"],
    ["缺口字节", s.gap_length, s.gap_length ? "bad" : "ok"],
    ["冲突字节", s.conflict_length, s.conflict_length ? "bad" : "ok"],
    ["同值去重字节", s.duplicate_bytes],
    ["分片是否按序到达", r.in_order ? "是" : "否（乱序）", r.in_order ? "ok" : "warn"],
  ].forEach(([k, v, cls]) => stats.appendChild(addStat(k, v, cls)));

  renderBar(expected, r.coverage, r.conflicts);

  document.getElementById("coveredCount").textContent = `（${r.coverage.length} 段）`;
  document.getElementById("conflictCount").textContent = `（${r.conflicts.length} 段）`;
  document.getElementById("gapCount").textContent = `（${r.gaps.length} 段）`;
  fillRangeList(document.getElementById("coveredList"), r.coverage, "无覆盖", LIST_LIMIT);
  fillRangeList(document.getElementById("conflictList"), r.conflicts, "无冲突", LIST_LIMIT);
  fillRangeList(document.getElementById("gapList"), r.gaps, "无缺口，[0, 预期长度) 全覆盖", LIST_LIMIT);

  // 冲突取值抽样
  const samples = document.getElementById("conflictSamples");
  samples.innerHTML = "";
  r.conflict_samples.forEach((sm) => {
    const line = document.createElement("div");
    line.className = "sample-line";
    const vals = sm.values.map((v) => v.toString(16).padStart(2, "0")).join(" ≠ ");
    line.textContent = `偏移 ${sm.offset} (${hexOff(sm.offset)})：收到过 ${vals}`;
    samples.appendChild(line);
  });
  if (r.conflict_samples_truncated) {
    const more = document.createElement("div");
    more.className = "hint";
    more.textContent = "冲突位置过多，仅展示前若干个位置的取值。";
    samples.appendChild(more);
  }

  // 分片表
  const tbody = document.querySelector("#fragTable tbody");
  tbody.innerHTML = "";
  r.fragments.forEach((f, i) => {
    const tr = document.createElement("tr");
    const clientLen = hexByteLen(submitted[i].data);
    tr.innerHTML = `<td>${f.index}</td><td><code>${f.offset} (${hexOff(f.offset)})</code></td>
      <td>${f.length}${clientLen !== f.length ? " (输入解析异常!)" : ""}</td>
      <td><code>[${f.offset}, ${f.end})</code></td>`;
    tbody.appendChild(tr);
  });

  renderPreview(expected, r.preview_hex || "", r.preview_truncated, r.conflicts);

  if (r.downloadable) {
    dlBtn.hidden = false;
    note.textContent = `下载内容为重组后的 ${expected} 字节原始二进制。`;
    dlBtn.onclick = () => {
      window.location.href = r.download_url;
    };
  } else {
    note.textContent = "仅当范围完整且无冲突时才提供下载。";
  }
}

// 初始放一个空分片，方便直接输入
addFragment();

// 输入发生变化后，旧的重组结果不再可信，隐藏结果区
function invalidateResult() {
  els.resultCard.hidden = true;
  els.error.hidden = true;
}
els.expectedLength.addEventListener("input", invalidateResult);
els.fragments.addEventListener("input", invalidateResult);
