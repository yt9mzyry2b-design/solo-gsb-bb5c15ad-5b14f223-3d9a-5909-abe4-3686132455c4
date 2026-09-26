# 单向抓包负载重组工具（pcap-reassembler）

用于网络排障的**单向**抓包负载重组网页：你知道某条数据流每个分片应当落在负载中的什么字节位置，但分片可能乱序到达、重复发送或相互矛盾。把「预期字节数」和每个分片的「起始偏移 + 十六进制内容」填入页面，服务端按字节位置重组，并直观展示覆盖、冲突与缺口。

技术栈：Python 3.11 + FastAPI + 原生 JavaScript（无前端构建、无第三方 JS 依赖）。

## 功能说明

- **按字节位置重组**：分片起始偏移支持十进制或 `0x` 十六进制，内容支持连续 hex、空格或冒号分隔（如 `48656c6c6f`、`48:65:6c`）。
- **重叠处理**
  - 同一字节位置被多次覆盖且**取值相同** → 自动去重，计入「同值去重字节」；
  - 取值**不同** → 该字节标记为**冲突**，页面给出冲突区间，并抽样列出每个冲突偏移收到过的不同值。
- **缺口清单**：列出从 `0` 到预期长度（左闭右开 `[0, N)`）内的**全部未覆盖区间**，逐字节无遗漏。
- **可视化**：按偏移绘制覆盖 / 冲突 / 缺口色带（悬停查看字节范围），并提供 16 字节一行的 hex dump 预览。
- **下载门槛**：只有当范围**完整（无任何缺口）且无冲突**时，才出现「下载还原的二进制」按钮；否则只给出原因，不提供下载。
- **双次抓包差异定位（A/B 对比）**：对同一预期长度录入 A/B 两组分片并指定比较窗口，逐偏移判定两侧是**唯一值 / 缺口 / 冲突**；只有两侧均为唯一值时才归为**相同**或**不同**，其余归为**不可判定**并标明两侧原因（缺口 / 冲突）。连续同类且原因相同的字节合并为半开区间 `[start, end)`，页面展示各类字节数、差异区间与不可判定区间，并可用「上一窗口 / 下一窗口」平移窗口查看后续位置。窗口须落在 `[0, 预期长度)` 内且长度不超过 **65536** 字节。
- 结果只在服务端内存中临时保存（默认 100 份 / 30 分钟，LRU + 过期淘汰），过期后需重新重组。

## 一条命令启动（Docker Compose）

需要已安装 Docker 与 Compose 插件（`docker compose version` 可用）。

```bash
docker compose up --build -d
```

该命令会自动构建镜像、安装全部 Python 依赖并在后台启动服务。

访问：

- 网页界面：<http://localhost:8000/>
- 健康检查 / 当前限制：<http://localhost:8000/api/health>
- 接口文档（Swagger）：<http://localhost:8000/docs>

停止与清理：

```bash
docker compose down          # 停止
docker compose down -v       # 停止并清理（无持久化卷）
```

> 端口固定为容器内 **8000**；如需换宿主机端口，修改 `docker-compose.yml` 中的 `ports`，例如 `"9000:8000"`。

## 必要配置

所有配置均通过 `docker-compose.yml` 的 `environment` 设置，均有默认值，不配也能直接用：

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `MAX_EXPECTED_LENGTH` | `16777216`（16 MiB） | 单次重组预期负载的最大字节数 |
| `MAX_FRAGMENTS` | `4096` | 单次请求最多分片数 |
| `MAX_TOTAL_INPUT` | `67108864`（64 MiB） | 所有分片原始字节（含重叠）总量上限 |
| `MAX_DIFF_WINDOW` | `65536` | 双次抓包差异定位的比较窗口最大字节数 |
| `JOB_RETENTION_COUNT` | `100` | 可下载结果在内存中保留的最大份数 |
| `JOB_RETENTION_SECONDS` | `1800`（30 分钟） | 可下载结果的保留时长 |

监听地址与端口通过容器启动命令固定为 `0.0.0.0:8000`，宿主机映射在 Compose 的 `ports` 中调整。

## 本地（非 Docker）运行

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

## HTTP 接口

### `POST /api/reassemble`

请求体：

```json
{
  "expected_length": 16,
  "fragments": [
    {"offset": 0,  "data": "48656c6c6f20576f726c64"},
    {"offset": 10, "data": "643020746f21"}
  ]
}
```

上例中 `Hello World` 覆盖 `[0,11)`，`d0 to!` 覆盖 `[10,16)`，偏移 10 处两片同为 `64`（`d`），自动去重；最终完整负载为 `Hello World0 to!`。

响应（节选）：

```json
{
  "expected_length": 16,
  "complete": true,
  "has_conflict": false,
  "downloadable": true,
  "in_order": true,
  "stats": {"fragment_count": 2, "covered_length": 16, "gap_length": 0,
            "conflict_length": 0, "duplicate_bytes": 1, "total_input_bytes": 17},
  "coverage": [[0, 16]],
  "conflicts": [],
  "gaps": [],
  "conflict_samples": [],
  "preview_hex": "…",
  "job_id": "…",
  "download_url": "/api/download/<job_id>"
}
```

- `coverage` / `conflicts` / `gaps` 均为 `[起始偏移, 结束偏移)` 的有序区间数组；
- 分片越界、奇数位 hex、非 hex 字符、预期长度超限等输入错误统一返回 `400 {"detail": "..."}`；
- `downloadable=false` 时 `job_id` 与 `download_url` 为 `null`。

### `POST /api/diff`

双次抓包差异定位：A/B 两组分片共用同一 `expected_length`，校验规则与输入上限（hex 解析、分片数、字节总量、预期长度）与 `/api/reassemble` 完全一致，其中字节总量上限对两侧合并计算。

请求体：

```json
{
  "expected_length": 24,
  "window_start": 0,
  "window_length": 24,
  "fragments_a": [
    {"offset": 0,  "data": "000102030405060708090a0b0c0d0e0f"},
    {"offset": 16, "data": "1011121314151617"},
    {"offset": 20, "data": "1415ff17"}
  ],
  "fragments_b": [
    {"offset": 0,  "data": "000102030405060708090a0b"},
    {"offset": 16, "data": "1099121314151617"}
  ]
}
```

约束：`window_start ≥ 0`、`1 ≤ window_length ≤ 65536`（可用 `MAX_DIFF_WINDOW` 调整）、`window_start + window_length ≤ expected_length`，违反任一约束返回 `400 {"detail": "..."}`。

响应（对应上例）：

```json
{
  "expected_length": 24,
  "window": {"start": 0, "length": 24, "end": 24},
  "max_window_length": 65536,
  "counts": {"same": 18, "diff": 1, "undecidable": 5},
  "runs": [
    {"start": 0,  "end": 12, "category": "same",        "reason_a": null,       "reason_b": null},
    {"start": 12, "end": 16, "category": "undecidable", "reason_a": null,       "reason_b": "gap"},
    {"start": 16, "end": 17, "category": "same",        "reason_a": null,       "reason_b": null},
    {"start": 17, "end": 18, "category": "diff",        "reason_a": null,       "reason_b": null},
    {"start": 18, "end": 22, "category": "same",        "reason_a": null,       "reason_b": null},
    {"start": 22, "end": 23, "category": "undecidable", "reason_a": "conflict", "reason_b": null},
    {"start": 23, "end": 24, "category": "same",        "reason_a": null,       "reason_b": null}
  ],
  "diff_runs": [[17, 18]],
  "undecidable_runs": [
    {"start": 12, "end": 16, "reason_a": null,       "reason_b": "gap"},
    {"start": 22, "end": 23, "reason_a": "conflict", "reason_b": null}
  ],
  "sides": {
    "a": {"fragment_count": 3, "covered_length": 24, "gap_length": 0, "conflict_length": 1, "…": "…"},
    "b": {"fragment_count": 2, "covered_length": 20, "gap_length": 4, "conflict_length": 0, "…": "…"}
  }
}
```

- 逐字节判定规则：某偏移两侧均为**唯一值**时，取值相等归 `same`、不等归 `diff`；任一侧为**缺口**或**冲突**时归 `undecidable`，`reason_a` / `reason_b` 分别记录该侧原因（`"gap"` / `"conflict"`，`null` 表示该侧为唯一值）。
- `runs` 为整个窗口的合并结果：连续同类且两侧原因相同的字节合并为一个半开区间 `[start, end)`；`diff_runs` 与 `undecidable_runs` 是其中的差异 / 不可判定子集，便于直接展示。
- `counts` 为窗口内各类别的字节数，三者之和等于 `window.length`。
- `sides` 为两侧在**整个** `[0, expected_length)` 范围内的整体统计（覆盖 / 缺口 / 冲突字节数等），不局限于窗口。
- 差异定位不产生可下载结果；下载仍由 `/api/reassemble` 提供。

### `GET /api/download/{job_id}`

下载重组完成的原始二进制（`application/octet-stream`）。结果过期或未知返回 404。

## 快速试用

打开页面后可点击：

- **「填充示例：乱序+冲突+缺口」**：验证乱序排序、异值冲突标红和尾部缺口；
- **「填充示例：完整可下载」**：两片在偏移 10 处同值重叠（去重），覆盖全部 16 字节，可直接下载；
- **「填充对比示例」**（差异定位区）：A 侧在偏移 22 处有冲突、B 侧缺 `[12,16)`、偏移 17 处两侧取值不同，可看到「相同 18 / 不同 1 / 不可判定 5」的统计与区间合并效果；再点「下一窗口 →」可平移比较窗口。

## 目录结构

```
.
├── app/
│   ├── __init__.py
│   ├── main.py          # FastAPI 路由、任务缓存、静态托管
│   └── reassembly.py    # 重组核心：去重 / 冲突 / 缺口；A/B 差异定位
├── static/
│   ├── index.html       # 页面结构
│   ├── app.js           # 原生 JS：单次重组表单、可视化、下载
│   ├── diff.js          # 原生 JS：A/B 双次抓包差异定位
│   └── style.css
├── Dockerfile
├── docker-compose.yml
└── requirements.txt
```

## 排障提示

- **冲突是真实矛盾**：同一偏移收到不同字节通常意味着分片不属于同一条流、序列号推算错误或数据被篡改。工具不会替你猜测采用哪个值，预览中保留最先到达的值，冲突字节以红色标出。
- **缺口按字节列出**：即使只丢了 1 个字节也无法还原完整负载，下载按钮保持禁用。
- **大负载**：重组复杂度与「预期长度 + 输入字节总量」成线性关系；默认上限适合一般报文级排障，更大场景请调大对应环境变量并留意容器内存。
