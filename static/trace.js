"use strict";

// 分片到达过程诊断（/api/arrival-trace）。
// 复用 app.js 中的全局函数：
//   readReassemblyForm / showError / hexOff / addStat / els
// （app.js 先于本文件加载）。

const TRACE_SAMPLE_LIST_LIMIT = 400;

const traceEls = {
  submit: document.getElementById("traceSubmit"),
  card: document.getElementById("traceCard"),
  banner: document.getElementById("traceBanner"),
  stats: document.getElementById("traceStats"),
  tbody: document.querySelector("#traceTable tbody"),
  samples: document.getElementById("traceSamples"),
  sampleCount: document.getElementById("traceSampleCount"),
  sampleNote: document.getElementById("traceSampleNote"),
};

function hex2(v) {
  return v.toString(16).padStart(2, "0");
}

function submitArrivalTrace() {
  els.error.hidden = true;

  let payload;
  try {
    const { expected, fragments } = readReassemblyForm();
    payload = { expected_length: expected, fragments };
  } catch (e) {
    showError(e.message);
    return;
  }

  traceEls.submit.disabled = true;
  traceEls.submit.textContent = "诊断中…";
  fetch("/api/arrival-trace", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
    .then(async (resp) => {
      const body = await resp.json();
      if (!resp.ok) throw new Error(body.detail || `HTTP ${resp.status}`);
      renderTrace(body);
    })
    .catch((e) => showError(e.message))
    .finally(() => {
      traceEls.submit.disabled = false;
      traceEls.submit.textContent = "分片到达过程诊断";
    });
}

function renderTrace(r) {
  traceEls.card.hidden = false;
  traceEls.card.scrollIntoView({ behavior: "smooth", block: "start" });

  const s = r.stats;
  if (r.first_conflict_step === null) {
    traceEls.banner.className = "banner ok";
    traceEls.banner.textContent =
      `✓ 全部 ${s.fragment_count} 个分片录入完毕，未出现异值冲突：` +
      `已覆盖 ${s.covered_length} / ${r.expected_length} 字节` +
      (s.gap_length ? `，缺口 ${s.gap_length} 字节。` : "，无缺口。");
  } else {
    traceEls.banner.className = "banner bad";
    traceEls.banner.textContent =
      `✗ 分片 #${r.first_conflict_step} 首个引入冲突（该步新增 ${
        r.steps[r.first_conflict_step - 1].first_conflict_bytes
      } 个冲突字节）；最终共 ${s.conflict_length} 字节冲突。`;
  }

  // 顶部统计
  traceEls.stats.innerHTML = "";
  [
    ["分片数", s.fragment_count],
    ["输入字节总量", s.total_input_bytes],
    ["最终已覆盖字节", `${s.covered_length} / ${r.expected_length}`, s.gap_length ? "warn" : "ok"],
    ["最终缺口字节", s.gap_length, s.gap_length ? "warn" : "ok"],
    ["最终冲突字节", s.conflict_length, s.conflict_length ? "bad" : "ok"],
    [
      "首个冲突分片",
      r.first_conflict_step === null ? "无" : `#${r.first_conflict_step}`,
      r.first_conflict_step === null ? "ok" : "bad",
    ],
  ].forEach(([k, v, cls]) => traceEls.stats.appendChild(addStat(k, v, cls)));

  // 步骤表
  traceEls.tbody.innerHTML = "";
  const TRACE_STEP_ROW_LIMIT = 2000;
  const shownSteps = r.steps.slice(0, TRACE_STEP_ROW_LIMIT);
  shownSteps.forEach((st) => {
    const tr = document.createElement("tr");
    let rowCls = "";
    if (st.first_conflict_bytes > 0) {
      rowCls = st.index === r.first_conflict_step ? "trace-first-conflict" : "trace-conflict";
    }
    if (rowCls) tr.className = rowCls;
    tr.innerHTML = `
      <td>${st.index}${st.index === r.first_conflict_step ? ' <span title="首个引入冲突的分片">⚠</span>' : ""}</td>
      <td><code>${st.offset} (${hexOff(st.offset)})</code></td>
      <td>${st.length}</td>
      <td><code>[${st.offset}, ${st.end})</code></td>
      <td>${st.new_covered_bytes}</td>
      <td class="num-conflict">${st.first_conflict_bytes}</td>
      <td>${st.same_value_bytes}</td>
      <td>${st.conflict_rewrite_bytes}</td>
      <td>${st.covered_total}</td>
      <td>${st.conflict_total}</td>`;
    traceEls.tbody.appendChild(tr);
  });
  if (r.steps.length > shownSteps.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 10;
    td.className = "trace-more";
    td.textContent = `… 其余 ${r.steps.length - shownSteps.length} 个步骤已省略（接口仍返回完整步骤）`;
    tr.appendChild(td);
    traceEls.tbody.appendChild(tr);
  }

  // 首次冲突样本（服务端已按上限裁剪）
  traceEls.samples.innerHTML = "";
  traceEls.sampleCount.textContent = `（${s.first_conflict_event_count} 个位置）`;
  const samples = r.first_conflict_samples || [];
  const shown = samples.slice(0, TRACE_SAMPLE_LIST_LIMIT);
  shown.forEach((sm) => {
    const line = document.createElement("div");
    line.className = "sample-line";
    line.textContent =
      `偏移 ${sm.offset} (${hexOff(sm.offset)})：最先由分片 #${sm.first_writer} 写入 ` +
      `${hex2(sm.first_value)}，分片 #${sm.trigger} 以 ${hex2(sm.trigger_value)} 触发首次冲突`;
    traceEls.samples.appendChild(line);
  });
  if (samples.length === 0) {
    const line = document.createElement("div");
    line.className = "hint";
    line.textContent = "无首次冲突样本：所有已覆盖位置均只出现过一个取值。";
    traceEls.samples.appendChild(line);
  }
  const omittedByClient = samples.length - shown.length;
  if (omittedByClient > 0 || r.first_conflict_samples_truncated) {
    traceEls.sampleNote.hidden = false;
    const parts = [];
    if (r.first_conflict_samples_truncated) {
      parts.push(
        `服务端仅保留前 ${r.first_conflict_sample_limit} 个首次冲突样本（实际共 ${s.first_conflict_event_count} 个位置）`
      );
    }
    if (omittedByClient > 0) {
      parts.push(`页面仅展示前 ${TRACE_SAMPLE_LIST_LIMIT} 条，其余 ${omittedByClient} 条已省略`);
    }
    traceEls.sampleNote.textContent = parts.join("；") + "。";
  } else {
    traceEls.sampleNote.hidden = true;
    traceEls.sampleNote.textContent = "";
  }
}

traceEls.submit.addEventListener("click", submitArrivalTrace);

// 输入发生变化后，旧的诊断结果不再可信，隐藏结果区
function invalidateTrace() {
  traceEls.card.hidden = true;
}
els.expectedLength.addEventListener("input", invalidateTrace);
els.fragments.addEventListener("input", invalidateTrace);
