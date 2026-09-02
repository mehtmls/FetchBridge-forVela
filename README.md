# FetchBridge for Vela

Xiaomi Vela QuickApp 上的浏览器风格 `fetch()`，底层通过 `@system.interconnect` 把 HTTP 请求转发到手机端执行。

---

## 你只需要知道这些

```js
import fetch from './fetchBridge.js'

const res = await fetch('https://api.example.com/user')

if (!res.ok) throw new Error('HTTP ' + res.status)

const data = await res.json()
```

完了。Handshake、Chunk、ACK、CRC32、Stream Frame 这些你都不用管。

---

## API

### `fetch(url, options?)`

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `url` | `string` | — | 请求地址 |
| `options.method` | `string` | `'GET'` | HTTP 方法 |
| `options.headers` | `object` | `{}` | 请求头（key 不区分大小写） |
| `options.body` | `string \| Uint8Array \| ArrayBuffer` | — | 请求体 |
| `options.timeout` | `number` | — | 超时（ms），超时抛异常 |
| `options.stream` | `boolean` | `false` | 开启流式响应 |
| `options.buffer` | `boolean` | **`true`** | 是否缓存完整响应 |
| `options.onChunk` | `function` | — | 流式回调 `(bytes, offset, total)` |
| `options.raw` | `boolean` | `false` | 不做 JSON 解析 |
| `options.followRedirects` | `boolean` | `false` | 跟随重定向 |
| `options.fixedChunks` | `boolean` | `false` | 固定分块模式 |

### Response 对象

| 属性/方法 | 说明 |
|-----------|------|
| `res.ok` | `status` 在 200-299 之间 |
| `res.status` | HTTP 状态码 |
| `res.statusText` | 状态文本 |
| `res.headers` | 响应头 |
| `res.bodyUsed` | body 是否已读取 |
| `res.text()` | 读文本 |
| `res.json()` | 读 JSON |
| `res.bytes()` | 读 `Uint8Array` |
| `res.arrayBuffer()` | 读 `ArrayBuffer` |

### 其他导出

```js
import fetch, { Response, getInterconnectState, getNegotiatedCaps } from './fetchBridge.js'
```

- `getInterconnectState()` → `{ ready, handshakeReady, connectionOpen }`
- `getNegotiatedCaps()` → 当前协商后的能力集（没有就返回 `null`）

---

## 三种响应模式

### 1. 普通模式（默认）

```js
const res = await fetch(url)
const data = await res.json()
```

响应完整缓存，随便调 `.text()` / `.json()` / `.bytes()`。

### 2. Stream + Buffer

```js
await fetch(url, {
  stream: true,
  buffer: true,   // ← 默认值，可以不写
  onChunk(bytes, offset, total) {
    console.log('收到', bytes.length, 'bytes')
  }
})
```

每个 chunk 实时回调，**同时**内部保留完整响应，结束后仍可 `res.bytes()`。

### 3. Stream + No Buffer（最低内存）

```js
await fetch(url, {
  stream: true,
  buffer: false,  // ← 必须显式关闭
  onChunk(bytes, offset, total) {
    // 直接处理，不要 push 到数组里
  }
})
```

**只在 `onChunk` 里处理数据**，不缓存完整响应。适合大文件下载。

> ⚠️ `buffer: false` 时必须提供 `onChunk`，否则没意义。

---

## 常见用法

### POST JSON

```js
const res = await fetch('https://api.example.com/user', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'Alice', age: 18 })
})
```

### 自定义 Headers

```js
await fetch(url, {
  headers: {
    'Authorization': 'Bearer xxx',
    'X-Device-Type': 'watch'
  }
})
```

### 二进制下载

```js
const res = await fetch(url)
const bytes = await res.bytes()
console.log(bytes.length)
```

### 错误处理（推荐模板）

```js
try {
  const res = await fetch(url)
  if (!res.ok) throw new Error('HTTP ' + res.status)
  return await res.json()
} catch (err) {
  console.log('请求失败:', err.message)
  return null
}
```

> **注意**：HTTP 404/500 不会进 `catch`，只有 transport 层错误才会抛异常。

---

## 大文件流式下载

```js
let received = 0

await fetch(url, {
  stream: true,
  buffer: false,
  onChunk(bytes, offset, total) {
    received += bytes.length
    console.log(`${received} / ${total}`)
    // 直接写入文件 / 解码 / 渲染，别存数组
  }
})
```

内存占用从「整个文件」降到「一个 chunk（默认 4KB）」。

---

## 协议细节（你不用关心，但知道也没坏处）

### 握手

第一次 `fetch()` 自动触发：

```
__hs__ count=0  →  ← count=1
__hs__ count=1  →  ← count=2 (READY)
```

之后所有请求复用同一条 session，连接断了才会重新握手。

### 本地广播能力（v4）

```js
{
  version: 4,
  chunk: true,
  maxChunkSize: 4096,
  encodings: ['base64', 'text'],
  compressions: [],   // 故意空着，见下文
  ack: true,
  ackWindow: 4,
  stream: true
}
```

### 为什么 `compressions: []`

协议支持 `deflate` / `lz4`，但如果 QuickApp 端没有对应的解压实现，手机端选了压缩就等于白搭。**先实现解压器，再加进 `localCaps()`**——这是嵌入式端的安全选择。

### ACK 流控

默认 `chunkSize=4096` × `ackWindow=4` = 约 16KB 飞行窗口。手机端最多发 4 个 chunk 就必须等手表 ACK，避免内存爆掉。内存吃紧可以降到 `2048 × 2`，追求吞吐可以 `8192 × 4`。

### Stream Frame 校验

每个 frame 带 `seq` / `offset` / `crc32` / `final` / `totalBytes`。丢包、乱序、损坏都会被检测到并拒绝。

> **每个 frame 独立 Base64 编码**，必须逐个 decode，不能拼一起再 decode。

---

## 项目结构建议

```
src/
├── api/
│   └── fetchBridge.js     ← 放这里
├── services/
│   ├── user.js
│   └── download.js        ← 业务封装
└── pages/
    └── index/
        └── index.js       ← 页面只 import 业务层
```

业务层封装示例：

```js
// services/user.js
import fetch from '../api/fetchBridge.js'

export async function getUser() {
  const res = await fetch('https://api.example.com/user')
  if (!res.ok) throw new Error('HTTP ' + res.status)
  return res.json()
}
```

页面里 `import { getUser } from '../services/user'`，永远不直接碰 `@system.interconnect`。

---

## FAQ

**Q: 第一次 fetch 会自动握手吗？**
会。不需要手动调任何 `connect()` / `handshake()`。

**Q: 每次 fetch 都重新握手？**
不会。只有连接重建后才重新协商。

**Q: 手机没连上怎么办？**
`fetch()` 会等 Interconnect 就绪，超过 `timeout` 抛错。

**Q: 404 会进 catch？**
不会。`res.ok === false`，`res.status === 404`，由你决定怎么处理。

**Q: 普通 API 要关心 stream 吗？**
不用。`await fetch(url).then(r => r.json())` 完事。

---

## License

MIT
