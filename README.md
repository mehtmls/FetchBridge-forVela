AstroBox NG Interconnect Fetch

一个面向 Xiaomi Vela QuickApp 的浏览器风格 "fetch()" 网络请求封装。

它通过 Xiaomi Vela "@system.interconnect" 与手机端 AstroBox NG FetchBridge 通信，由手机端负责实际的 HTTP/HTTPS 网络请求。

对于 QuickApp 业务代码来说，你不需要了解：

- Interconnect
- FetchBridge
- Handshake
- Chunk
- ACK
- CRC32
- Base64
- Stream Frame
- 协议版本协商

只需要像浏览器一样：

import fetch from './fetch'

const response = await fetch(
  'https://example.com/api'
)

const data = await response.json()

---

1. 特性

浏览器风格 API

const response = await fetch(url)

支持：

- "GET"
- "POST"
- "PUT"
- "PATCH"
- "DELETE"
- 自定义 Headers
- JSON 请求
- 文本请求
- 二进制数据
- 普通响应
- Chunked Response
- Streaming Response

---

自动握手

第一次调用：

await fetch(url)

内部会自动完成：

fetch()
  │
  ├─ 检查 Interconnect
  │
  ├─ 等待连接
  │
  ├─ FetchBridge Handshake
  │
  ├─ 协商协议能力
  │
  └─ 发送真正的 HTTP 请求

开发者不需要手动调用：

handshake()
connect()
open()

Vela 的 Interconnect 本身会自动建立连接，QuickApp 通过 "interconnect.instance()" 获取单例连接对象。

---

2. 最简单的 GET

import fetch from './fetch'

async function load() {
  const response = await fetch(
    'https://example.com/api'
  )

  console.log(response.status)

  if (!response.ok) {
    throw new Error(
      'HTTP ' + response.status
    )
  }

  const data = await response.json()

  console.log(data)
}

---

3. 获取文本

const response = await fetch(
  'https://example.com/hello.txt'
)

const text = await response.text()

console.log(text)

---

4. 获取 JSON

const response = await fetch(
  'https://example.com/api/user'
)

const user = await response.json()

console.log(user.name)

---

5. POST JSON

const response = await fetch(
  'https://example.com/api/user',
  {
    method: 'POST',

    headers: {
      'Content-Type':
        'application/json'
    },

    body: JSON.stringify({
      name: 'Alice',
      age: 18
    })
  }
)

const result =
  await response.json()

---

6. 自定义 Headers

const response = await fetch(
  'https://example.com/api',
  {
    headers: {
      'Authorization':
        'Bearer xxx',

      'X-Device-Type':
        'watch'
    }
  }
)

Header 名称不区分大小写。

---

7. Response API

"fetch()" 返回：

const response =
  await fetch(url)

Response 提供：

属性 / 方法| 说明
"ok"| HTTP 状态是否成功
"status"| HTTP 状态码
"statusText"| HTTP 状态文本
"headers"| HTTP Headers
"bodyUsed"| Body 是否已经读取
"text()"| 读取文本
"json()"| 读取 JSON
"bytes()"| 读取 "Uint8Array"
"arrayBuffer()"| 读取 "ArrayBuffer"

---

8. 判断 HTTP 错误

注意：

fetch()

本身不会因为 HTTP "404"、"500" 自动抛异常。

应该使用：

const response =
  await fetch(url)

if (!response.ok) {
  console.log(
    'HTTP error:',
    response.status
  )

  return
}

例如：

const response =
  await fetch(url)

if (response.status === 404) {
  console.log('Not Found')
}

if (response.status >= 500) {
  console.log('Server Error')
}

---

9. 读取二进制数据

如果接口返回图片、音频、文件等二进制数据：

const response =
  await fetch(url)

const bytes =
  await response.bytes()

console.log(
  bytes.length
)

"bytes()" 返回：

Uint8Array

也可以：

const buffer =
  await response.arrayBuffer()

---

10. 大文件 / 流式下载

对于手表来说，不建议把几十 MB 的数据一次性放进内存。

可以使用：

const response =
  await fetch(url, {
    stream: true,

    buffer: false,

    onChunk(
      bytes,
      offset,
      total
    ) {
      console.log(
        '收到:',
        bytes.length,
        'bytes'
      )

      console.log(
        '当前 offset:',
        offset
      )

      console.log(
        '总大小:',
        total
      )

      // 在这里直接处理数据
    }
  })

数据流：

手机
 │
 │ HTTP Response
 ▼
FetchBridge
 │
 ├── Chunk 0
 ├── Chunk 1
 ├── Chunk 2
 ├── Chunk 3
 │
 ▼
QuickApp
 │
 └── onChunk()

---

11. 为什么推荐 Streaming

普通模式：

const response =
  await fetch(url)

const bytes =
  await response.bytes()

内存模型：

整个文件
    ↓
QuickApp RAM

例如下载：

20 MB 文件

可能需要在 QuickApp 中保存接近：

20 MB

甚至更多临时对象。

---

Streaming：

await fetch(url, {
  stream: true,
  buffer: false,

  onChunk(bytes) {
    process(bytes)
  }
})

内存模型：

手机
 ↓
4KB Chunk
 ↓
QuickApp
 ↓
处理
 ↓
释放
 ↓
下一个 Chunk

因此更加适合：

- Xiaomi Watch
- 低内存设备
- 图片下载
- 音频下载
- 大 JSON
- 文件传输

---

12. "buffer" 的区别

默认模式

fetch(url)

响应会在内存中缓存。

可以：

const response =
  await fetch(url)

const bytes =
  await response.bytes()

---

Stream + Buffer

fetch(url, {
  stream: true,
  buffer: true,

  onChunk(bytes) {
    process(bytes)
  }
})

数据会：

onChunk()
   +
内部缓存

适合既需要实时处理，又需要最后保存完整 Response 的情况。

---

Stream + No Buffer

fetch(url, {
  stream: true,
  buffer: false,

  onChunk(bytes) {
    process(bytes)
  }
})

只进行实时处理。

这是：

«最低内存模式»

适合大文件。

---

13. Timeout

可以设置请求超时：

const response =
  await fetch(url, {
    timeout: 15000
  })

单位：

milliseconds

即：

15000 = 15 秒

超时会抛出异常。

try {
  const response =
    await fetch(url, {
      timeout: 15000
    })
} catch (error) {
  console.log(
    'request failed:',
    error.message
  )
}

---

14. 推荐的错误处理

推荐业务代码统一：

try {
  const response =
    await fetch(url)

  if (!response.ok) {
    throw new Error(
      'HTTP ' +
      response.status
    )
  }

  const data =
    await response.json()

  return data

} catch (error) {

  console.log(
    'Network error:',
    error.message
  )

  return null
}

这样业务层完全不需要关心：

Interconnect
FetchBridge
Handshake
Chunk
ACK

---

15. API 参数

fetch()

fetch(url, options)

"url"

类型：

String

例如：

fetch(
  'https://example.com/api'
)

---

"options.method"

HTTP 方法：

{
  method: 'POST'
}

默认：

GET

---

"options.headers"

HTTP Headers：

{
  headers: {
    'Content-Type':
      'application/json'
  }
}

---

"options.body"

请求 Body：

{
  body:
    JSON.stringify(data)
}

支持：

- String
- Uint8Array
- ArrayBuffer

---

"options.stream"

是否使用流式响应：

{
  stream: true
}

默认：

false

---

"options.buffer"

是否缓存完整响应：

{
  stream: true,
  buffer: false
}

对于大文件推荐：

stream: true
buffer: false

---

"options.onChunk"

流式数据回调：

{
  stream: true,

  onChunk(
    bytes,
    offset,
    total
  ) {
    // ...
  }
}

参数：

参数| 类型| 说明
"bytes"| "Uint8Array"| 当前数据
"offset"| "Number"| 当前数据偏移
"total"| "Number"| 总大小，未知时可能为 0

---

"options.timeout"

请求超时时间：

{
  timeout: 10000
}

单位：

毫秒

---

16. 协议握手

FetchBridge 内部使用：

__hs__

作为握手 Tag。

第一次通信：

{
  "tag": "__hs__",
  "count": 0,
  "caps": {}
}

对端响应：

{
  "tag": "__hs__",
  "count": 1,
  "caps": {}
}

之后：

count 0
   ↓
count 1
   ↓
count 2
   ↓
READY

业务代码完全不需要操作这些数据。

---

17. 为什么必须握手

握手主要用于协商：

协议版本
Chunk
Chunk Size
Encoding
Compression
ACK
ACK Window
Stream

例如 QuickApp 支持：

Protocol: v4
Chunk: yes
Chunk Size: 4096
ACK: yes
ACK Window: 4
Stream: yes
Encoding: base64 / text
Compression: none

手机端收到后会选择双方都支持的能力。

---

18. QuickApp 默认能力

当前 QuickApp 推荐广播：

{
  version: 4,

  chunk: true,

  maxChunkSize: 4096,

  encodings: [
    'base64',
    'text'
  ],

  compressions: [],

  ack: true,

  ackWindow: 4,

  stream: true
}

---

19. 为什么不默认启用 deflate / lz4

协议支持：

deflate
lz4

但是：

«QuickApp 端没有必要为了协议兼容而默认实现这两个解压器。»

如果 QuickApp 广播：

compressions: [
  'deflate',
  'lz4'
]

意味着手机端可能选择压缩。

但是如果手表端没有对应解压能力：

手机
 ↓
deflate
 ↓
QuickApp
 ↓
无法解压

因此当前版本主动广播：

compressions: []

即：

不协商压缩

这样更加安全，也更加适合嵌入式设备。

---

20. Chunk 模式

对于普通的大响应，FetchBridge 可以把数据拆成：

Response
 │
 ├── Chunk 0
 ├── Chunk 1
 ├── Chunk 2
 └── Chunk 3

默认：

Chunk Size = 4096 bytes

也就是：

4 KB

---

21. ACK 流控

为了避免手机端一次性向手表发送大量数据，协议支持：

ACK Window

当前默认：

ACK Window = 4

也就是说最多允许大约：

4096 × 4
=
16384 bytes

处于等待确认状态。

数据流：

Phone
 │
 ├── Chunk 0
 ├── Chunk 1
 ├── Chunk 2
 └── Chunk 3
        ↓
      ACK 4
        ↓
 ├── Chunk 4
 ├── Chunk 5
 ├── Chunk 6
 └── Chunk 7

这比无限制发送更加适合手表。

---

22. 为什么选择 4096 × 4

默认：

Chunk Size = 4096
ACK Window = 4

大约：

16 KB

的飞行数据窗口。

这是一个偏保守的嵌入式配置：

低内存
+
较低 GC 压力
+
不会让手机端无限发送
+
吞吐量仍然足够

如果设备内存更加紧张，可以进一步调整到：

2048 × 2

即约：

4 KB

如果追求更高吞吐量，可以使用：

8192 × 4

即：

32 KB

但对于普通手表业务，不建议一开始就把窗口开得太大。

---

23. Stream 模式

v4 Stream 与普通 Chunk 的区别：

Chunk

HTTP Response
    ↓
先知道完整响应
    ↓
拆成 Chunk
    ↓
发送

Stream

HTTP Response
    ↓
数据来了
    ↓
立即发送
    ↓
数据又来了
    ↓
继续发送
    ↓
直到 HTTP Response 结束

因此 Stream 更适合：

大文件
实时数据
音频
视频
持续 HTTP Response

---

24. Stream Frame 校验

v4 Stream Frame 包含：

seq
offset
data
crc32
final
totalBytes

QuickApp 会检查：

seq
offset
CRC32

如果发生：

丢包
乱序
数据损坏

会拒绝继续消费错误数据。

---

25. 重要：每个 Stream Frame 独立编码

例如：

Frame 0
data = base64(...)

以及：

Frame 1
data = base64(...)

必须：

Frame 0 → decode
Frame 1 → decode

不能：

base64(Frame0) + base64(Frame1)
                    ↓
              一次性 decode

因为每一个 Base64 Frame 都是独立编码的数据。

当前 QuickApp 实现已经按照这个规则处理。

---

26. Interconnect 连接

底层使用：

import interconnect from '@system.interconnect'

const connect =
  interconnect.instance()

Vela 官方文档说明：

- Interconnect 连接会自动建立
- "instance()" 返回 App 内的单例连接对象
- 可以通过 "getReadyState()" 查看连接状态
- 可以通过 "onopen" / "onclose" / "onerror" 监听连接变化
- 使用 "send()" 发送数据
- 使用 "onmessage" 接收数据。

因此业务代码不应该自己创建所谓：

new Connection()

或者自己维护：

connect()
disconnect()
reconnect()

这些属于底层 Transport 层。

---

27. Vela 项目要求

使用 Interconnect 前，需要保证：

QuickApp
   +
Android App

两者的：

Package Name
Signature

保持一致。

Vela 官方文档明确要求 QuickApp 的 "manifest.json" 中 "package" 与需要接入的 Android App 包名一致，并要求签名匹配。

例如：

{
  "package": "com.example.myapp"
}

必须与 Android App：

com.example.myapp

一致。

---

28. 推荐项目结构

推荐：

src/
│
├── api/
│   └── fetch.js
│
├── services/
│   ├── user.js
│   ├── device.js
│   └── download.js
│
└── pages/
    └── index/
        └── index.js

业务层：

import fetch from '../api/fetch'

然后只使用：

fetch()

不要在业务代码中直接：

import interconnect from '@system.interconnect'

这样可以把协议实现完全隔离。

---

29. 推荐封装业务 API

例如：

import fetch from './fetch'

export async function getUser() {
  const response =
    await fetch(
      'https://example.com/api/user'
    )

  if (!response.ok) {
    throw new Error(
      'HTTP ' +
      response.status
    )
  }

  return response.json()
}

业务页面：

import {
  getUser
} from './api'

async function load() {
  const user =
    await getUser()

  console.log(
    user.name
  )
}

这样以后即使：

Interconnect
↓
FetchBridge
↓
协议版本
↓
Chunk
↓
Stream

发生变化，业务代码也不需要修改。

---

30. 推荐开发者只记住这几个 API

普通开发者实际上只需要知道：

fetch(url)

fetch(url, {
  method: 'POST',
  headers: {},
  body: ''
})

response.text()

response.json()

response.bytes()

以及大文件：

fetch(url, {
  stream: true,
  buffer: false,

  onChunk(bytes) {
    // process bytes
  }
})

除此之外：

Handshake
Chunk
ACK
CRC32
Encoding
Stream Frame

都属于内部实现。

---

31. 完整示例

import fetch from './fetch'

async function requestUser() {
  try {

    const response =
      await fetch(
        'https://example.com/api/user'
      )

    if (!response.ok) {
      throw new Error(
        'HTTP ' +
        response.status
      )
    }

    const user =
      await response.json()

    console.log(
      'User:',
      user
    )

  } catch (error) {

    console.log(
      'Request failed:',
      error.message
    )
  }
}

---

32. 大文件完整示例

import fetch from './fetch'

async function downloadFile(
  url
) {

  let received = 0

  await fetch(
    url,
    {
      stream: true,

      buffer: false,

      onChunk:
        function (
          bytes,
          offset,
          total
        ) {

          received +=
            bytes.length

          console.log(
            received +
            ' / ' +
            total
          )

          /*
           * 在这里直接处理 bytes。
           *
           * 不要：
           *
           * chunks.push(bytes)
           *
           * 否则又会失去流式模式
           * 的低内存优势。
           */
        }
    }
  )
}

---

33. 设计原则

本库遵循几个原则。

业务简单

业务开发者看到的是：

fetch()

而不是：

Interconnect
FetchBridge
Handshake
Chunk
ACK
CRC32

---

默认安全

不会默认协商 QuickApp 没有实现的：

deflate
lz4

---

默认低内存

使用：

Chunk
+
ACK Window
+
Stream

避免一次性占用大量内存。

---

默认低 GC

尽量：

复用连接
减少临时对象
限制 in-flight 数据
避免无意义复制

---

协议与业务分离

业务：

fetch(url)

协议：

__hs__
fetch
fetch-chunk
fetch-ack
fetch-stream
fetch-stream-ack
fetch-stream-cancel

完全隔离。

---

34. 常见问题

Q：第一次 fetch 会不会自动握手？

会。

await fetch(url)

第一次调用时自动执行：

Interconnect Ready
        ↓
FetchBridge Handshake
        ↓
Capability Negotiation
        ↓
HTTP Fetch

不需要开发者手动处理。

---

Q：每一次 fetch 都会重新握手吗？

不会。

正常情况下：

第一次 fetch
    ↓
握手
    ↓
READY
    ↓
fetch
    ↓
fetch
    ↓
fetch
    ↓
fetch

只有连接重新建立后，才会重新建立新的 FetchBridge session。

---

Q：手机没连接怎么办？

"fetch()" 会等待 Interconnect 建立连接。

如果超过 timeout：

{
  timeout: 10000
}

则抛出错误。

---

Q：HTTP 404 会进入 catch 吗？

不会。

例如：

HTTP 404

仍然是一个正常的 HTTP Response：

response.ok === false
response.status === 404

只有 Transport / Interconnect / FetchBridge 层错误才会抛异常。

---

Q：大文件应该怎么处理？

推荐：

fetch(url, {
  stream: true,
  buffer: false,

  onChunk(bytes) {
    process(bytes)
  }
})

---

Q：普通 API 需要关心 stream 吗？

不需要。

直接：

const data =
  await fetch(url)
    .then(r => r.json())

即可。

---

35. 一句话总结

对于 QuickApp 开发者：

                 你写的代码

                     │
                     ▼

                fetch(url)
                     │
                     ▼
          ┌───────────────────┐
          │   Fetch Wrapper   │
          └───────────────────┘
                     │
                     ▼
              自动 Handshake
                     │
                     ▼
              Interconnect
                     │
                     ▼
             AstroBox NG
                     │
                     ▼
                HTTP/HTTPS
                     │
                     ▼
               Internet

你只需要使用 "fetch()"。

底层的：

连接
握手
协议协商
Chunk
ACK
CRC32
Stream

全部由这个模块自动处理。