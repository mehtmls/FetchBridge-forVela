/**
 * AstroBox / FetchBridge - Xiaomi Vela QuickApp fetch client
 *
 * Browser-like usage:
 *
 *   import fetch from './fetch'
 *
 *   const response = await fetch('https://example.com/api')
 *
 *   if (response.ok) {
 *     const data = await response.json()
 *   }
 *
 * POST:
 *
 *   const response = await fetch('https://example.com/api', {
 *     method: 'POST',
 *     headers: {
 *       'Content-Type': 'application/json'
 *     },
 *     body: JSON.stringify({
 *       hello: 'world'
 *     })
 *   })
 *
 * Streaming:
 *
 *   const response = await fetch(url, {
 *     stream: true,
 *     buffer: false,
 *     onChunk(bytes, offset, total) {
 *       // bytes: Uint8Array
 *       // offset: byte offset
 *       // total: total bytes, 0 when unknown
 *     }
 *   })
 *
 * Design goals:
 *   - low memory
 *   - low GC pressure
 *   - one interconnect singleton
 *   - one protocol handshake per connection session
 *   - bounded ACK window
 *   - no protocol details required by normal users
 */

import interconnect from '@system.interconnect'

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

const PROTOCOL_VERSION = 4

const DEFAULT_CHUNK_SIZE = 4096
const MAX_CHUNK_SIZE = 65536

const DEFAULT_ACK_WINDOW = 4
const MIN_ACK_WINDOW = 1
const MAX_ACK_WINDOW = 64

const HANDSHAKE_TIMEOUT = 10000

const DEFAULT_STREAM_BUFFER = true

/* -------------------------------------------------------------------------- */
/* Interconnect singleton                                                     */
/* -------------------------------------------------------------------------- */

const connect = interconnect.instance()

/* -------------------------------------------------------------------------- */
/* State                                                                      */
/* -------------------------------------------------------------------------- */

let handshakeReady = false
let handshakePromise = null
let connectionOpen = false

let requestSequence = 0

const pending = Object.create(null)
const handshakeWaiters = []

/* -------------------------------------------------------------------------- */
/* Negotiated capabilities                                                    */
/* -------------------------------------------------------------------------- */

let negotiatedCaps = {
  version: 1,
  chunked: false,
  chunkSize: DEFAULT_CHUNK_SIZE,
  stream: false,
  ack: false,
  ackWindow: 0,
  encodings: ['base64', 'text'],
  compressions: []
}

/* -------------------------------------------------------------------------- */
/* Small utilities                                                            */
/* -------------------------------------------------------------------------- */

function nowId() {
  requestSequence += 1

  return (
    Date.now().toString(36) +
    '-' +
    requestSequence.toString(36)
  )
}

function isObject(value) {
  return value !== null && typeof value === 'object'
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key)
}

function normalizeHeaders(headers) {
  const result = {}

  if (!headers) {
    return result
  }

  if (isObject(headers)) {
    const keys = Object.keys(headers)

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]
      result[key] = String(headers[key])
    }
  }

  return result
}

function findHeader(headers, name) {
  const target = String(name).toLowerCase()
  const keys = Object.keys(headers)

  for (let i = 0; i < keys.length; i++) {
    if (keys[i].toLowerCase() === target) {
      return headers[keys[i]]
    }
  }

  return null
}

function clamp(value, min, max) {
  value = Number(value)

  if (!isFinite(value)) {
    return min
  }

  if (value < min) {
    return min
  }

  if (value > max) {
    return max
  }

  return Math.floor(value)
}

/* -------------------------------------------------------------------------- */
/* UTF-8                                                                      */
/* -------------------------------------------------------------------------- */

function utf8Encode(text) {
  text = String(text)

  const bytes = []

  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i)

    if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      i + 1 < text.length
    ) {
      const low = text.charCodeAt(i + 1)

      if (low >= 0xdc00 && low <= 0xdfff) {
        code =
          0x10000 +
          ((code - 0xd800) << 10) +
          (low - 0xdc00)

        i++
      }
    }

    if (code <= 0x7f) {
      bytes.push(code)
    } else if (code <= 0x7ff) {
      bytes.push(
        0xc0 | (code >> 6),
        0x80 | (code & 0x3f)
      )
    } else if (code <= 0xffff) {
      bytes.push(
        0xe0 | (code >> 12),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      )
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      )
    }
  }

  return new Uint8Array(bytes)
}

function utf8Decode(bytes) {
  if (!bytes || bytes.length === 0) {
    return ''
  }

  let result = ''
  let i = 0

  while (i < bytes.length) {
    const first = bytes[i]

    if (first < 0x80) {
      result += String.fromCharCode(first)
      i++
      continue
    }

    if (
      first >= 0xc0 &&
      first <= 0xdf &&
      i + 1 < bytes.length
    ) {
      const code =
        ((first & 0x1f) << 6) |
        (bytes[i + 1] & 0x3f)

      result += String.fromCharCode(code)
      i += 2
      continue
    }

    if (
      first >= 0xe0 &&
      first <= 0xef &&
      i + 2 < bytes.length
    ) {
      const code =
        ((first & 0x0f) << 12) |
        ((bytes[i + 1] & 0x3f) << 6) |
        (bytes[i + 2] & 0x3f)

      result += String.fromCharCode(code)
      i += 3
      continue
    }

    if (
      first >= 0xf0 &&
      first <= 0xf7 &&
      i + 3 < bytes.length
    ) {
      let code =
        ((first & 0x07) << 18) |
        ((bytes[i + 1] & 0x3f) << 12) |
        ((bytes[i + 2] & 0x3f) << 6) |
        (bytes[i + 3] & 0x3f)

      code -= 0x10000

      result += String.fromCharCode(
        0xd800 | (code >> 10),
        0xdc00 | (code & 0x3ff)
      )

      i += 4
      continue
    }

    // Invalid UTF-8 byte.
    result += '\ufffd'
    i++
  }

  return result
}

/* -------------------------------------------------------------------------- */
/* Base64                                                                     */
/* -------------------------------------------------------------------------- */

const BASE64_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

const BASE64_LOOKUP = Object.create(null)

for (let i = 0; i < BASE64_CHARS.length; i++) {
  BASE64_LOOKUP[BASE64_CHARS.charAt(i)] = i
}

function base64Encode(bytes) {
  let result = ''
  let i = 0

  while (i < bytes.length) {
    const a = bytes[i++]
    const hasB = i < bytes.length
    const b = hasB ? bytes[i++] : 0
    const hasC = i < bytes.length
    const c = hasC ? bytes[i++] : 0

    const triple =
      (a << 16) |
      (b << 8) |
      c

    result += BASE64_CHARS.charAt(
      (triple >> 18) & 0x3f
    )

    result += BASE64_CHARS.charAt(
      (triple >> 12) & 0x3f
    )

    result += hasB
      ? BASE64_CHARS.charAt((triple >> 6) & 0x3f)
      : '='

    result += hasC
      ? BASE64_CHARS.charAt(triple & 0x3f)
      : '='
  }

  return result
}

function base64Decode(text) {
  text = String(text)

  const clean = text.replace(/[\r\n\s]/g, '')

  if (clean.length === 0) {
    return new Uint8Array(0)
  }

  if (clean.length % 4 !== 0) {
    throw new Error('Invalid base64 length')
  }

  const outputLength =
    (clean.length / 4) * 3 -
    (clean.charAt(clean.length - 1) === '=' ? 1 : 0) -
    (clean.charAt(clean.length - 2) === '=' ? 1 : 0)

  const bytes = new Uint8Array(outputLength)

  let out = 0

  for (let i = 0; i < clean.length; i += 4) {
    const c0 = clean.charAt(i)
    const c1 = clean.charAt(i + 1)
    const c2 = clean.charAt(i + 2)
    const c3 = clean.charAt(i + 3)

    const a = BASE64_LOOKUP[c0]
    const b = BASE64_LOOKUP[c1]

    if (a === undefined || b === undefined) {
      throw new Error('Invalid base64 data')
    }

    const c =
      c2 === '='
        ? 0
        : BASE64_LOOKUP[c2]

    const d =
      c3 === '='
        ? 0
        : BASE64_LOOKUP[c3]

    const triple =
      (a << 18) |
      (b << 12) |
      (c << 6) |
      d

    if (out < outputLength) {
      bytes[out++] = (triple >> 16) & 0xff
    }

    if (out < outputLength) {
      bytes[out++] = (triple >> 8) & 0xff
    }

    if (out < outputLength) {
      bytes[out++] = triple & 0xff
    }
  }

  return bytes
}

/* -------------------------------------------------------------------------- */
/* HEX                                                                        */
/* -------------------------------------------------------------------------- */

function hexDecode(text) {
  text = String(text)

  if ((text.length & 1) !== 0) {
    throw new Error('Invalid hex length')
  }

  const bytes = new Uint8Array(text.length / 2)

  for (let i = 0; i < text.length; i += 2) {
    const value = parseInt(
      text.substr(i, 2),
      16
    )

    if (isNaN(value)) {
      throw new Error('Invalid hex data')
    }

    bytes[i / 2] = value
  }

  return bytes
}

/* -------------------------------------------------------------------------- */
/* CRC32                                                                       */
/* -------------------------------------------------------------------------- */

const CRC32_TABLE = new Uint32Array(256)

;(function buildCrc32Table() {
  for (let i = 0; i < 256; i++) {
    let c = i

    for (let j = 0; j < 8; j++) {
      if (c & 1) {
        c =
          0xedb88320 ^
          (c >>> 1)
      } else {
        c >>>= 1
      }
    }

    CRC32_TABLE[i] = c >>> 0
  }
})()

function crc32(bytes) {
  let crc = 0xffffffff

  for (let i = 0; i < bytes.length; i++) {
    crc =
      CRC32_TABLE[
        (crc ^ bytes[i]) & 0xff
      ] ^
      (crc >>> 8)
  }

  return (
    (~crc >>> 0)
      .toString(16)
      .padStart(8, '0')
  )
}

/* -------------------------------------------------------------------------- */
/* Wire codec                                                                  */
/* -------------------------------------------------------------------------- */

function decodeWireData(text, encoding) {
  switch (encoding) {
    case 'text':
      return utf8Encode(text)

    case 'base64':
      return base64Decode(text)

    case 'hex':
      return hexDecode(text)

    default:
      throw new Error(
        'Unsupported bodyEncoding: ' + encoding
      )
  }
}

function encodeRequestBody(body) {
  if (body === undefined || body === null) {
    return null
  }

  if (typeof body === 'string') {
    return body
  }

  if (
    typeof Uint8Array !== 'undefined' &&
    body instanceof Uint8Array
  ) {
    return base64Encode(body)
  }

  if (
    typeof ArrayBuffer !== 'undefined' &&
    body instanceof ArrayBuffer
  ) {
    return base64Encode(
      new Uint8Array(body)
    )
  }

  return String(body)
}

/* -------------------------------------------------------------------------- */
/* Response body store                                                        */
/* -------------------------------------------------------------------------- */

function ByteStore(totalBytes) {
  this.chunks = []
  this.total = 0
  this.expected = (
    typeof totalBytes === 'number' &&
    totalBytes >= 0
  )
    ? totalBytes
    : 0
}

ByteStore.prototype.push = function (bytes) {
  if (!bytes || bytes.length === 0) {
    return
  }

  this.chunks.push(bytes)
  this.total += bytes.length
}

ByteStore.prototype.bytes = function () {
  if (this.chunks.length === 0) {
    return new Uint8Array(0)
  }

  if (
    this.chunks.length === 1 &&
    this.chunks[0].length === this.total
  ) {
    return this.chunks[0]
  }

  const result = new Uint8Array(this.total)

  let offset = 0

  for (let i = 0; i < this.chunks.length; i++) {
    result.set(
      this.chunks[i],
      offset
    )

    offset += this.chunks[i].length
  }

  return result
}

/* -------------------------------------------------------------------------- */
/* Response class                                                             */
/* -------------------------------------------------------------------------- */

export class Response {
  constructor(meta, bodyStore, streamed) {
    this.ok = !!meta.ok
    this.status = Number(meta.status || 0)
    this.statusText =
      meta.statusText || ''

    this.headers =
      meta.headers || {}

    this.bodyUsed = false

    this._raw = !!meta.raw
    this._bodyStore =
      bodyStore || null

    this._streamed = !!streamed
    this._complete = !streamed
    this._completionPromise = null
  }

  _ensureBodyAvailable() {
    if (this._streamed && !this._complete) {
      throw new Error(
        'Response body is still streaming'
      )
    }

    if (!this._bodyStore) {
      throw new Error(
        'Response body is not buffered'
      )
    }
  }

  async text() {
    if (this.bodyUsed) {
      throw new TypeError(
        'Body already used'
      )
    }

    this.bodyUsed = true

    this._ensureBodyAvailable()

    return utf8Decode(
      this._bodyStore.bytes()
    )
  }

  async json() {
    const text = await this.text()

    return JSON.parse(text)
  }

  async bytes() {
    if (this.bodyUsed) {
      throw new TypeError(
        'Body already used'
      )
    }

    this.bodyUsed = true

    this._ensureBodyAvailable()

    return this._bodyStore.bytes()
  }

  async arrayBuffer() {
    const bytes = await this.bytes()

    return bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    )
  }

  async waitForComplete() {
    if (!this._completionPromise) {
      return this
    }

    await this._completionPromise

    return this
  }
}

/* -------------------------------------------------------------------------- */
/* Error handling                                                             */
/* -------------------------------------------------------------------------- */

function makeError(message) {
  return new TypeError(
    String(message || 'Network error')
  )
}

function rejectPending(id, error) {
  const item = pending[id]

  if (!item) {
    return
  }

  delete pending[id]

  if (item.timer) {
    clearTimeout(item.timer)
    item.timer = null
  }

  item.reject(error)
}

function rejectAllPending(error) {
  const ids = Object.keys(pending)

  for (let i = 0; i < ids.length; i++) {
    rejectPending(ids[i], error)
  }
}

/* -------------------------------------------------------------------------- */
/* Interconnect send                                                          */
/* -------------------------------------------------------------------------- */

function sendMessage(message) {
  return new Promise(function (resolve, reject) {
    try {
      connect.send({
        data: message,

        success: function () {
          resolve()
        },

        fail: function (data, code) {
          let messageText = 'Interconnect send failed'

          if (data && data.data) {
            messageText = String(data.data)
          } else if (data) {
            messageText = String(data)
          }

          if (code !== undefined) {
            messageText +=
              ' (code ' +
              code +
              ')'
          }

          reject(
            makeError(messageText)
          )
        }
      })
    } catch (error) {
      reject(error)
    }
  })
}

/* -------------------------------------------------------------------------- */
/* Connection state                                                           */
/* -------------------------------------------------------------------------- */

function getReadyState() {
  return new Promise(function (resolve) {
    try {
      connect.getReadyState({
        success: function (data) {
          resolve(
            data &&
            Number(data.status) === 1
          )
        },

        fail: function () {
          resolve(false)
        }
      })
    } catch (error) {
      resolve(false)
    }
  })
}

function waitForConnection(timeout) {
  if (connectionOpen) {
    return Promise.resolve()
  }

  return getReadyState().then(
    function (ready) {
      if (ready) {
        connectionOpen = true
        return
      }

      return new Promise(function (
        resolve,
        reject
      ) {
        let finished = false

        const timer = setTimeout(
          function () {
            if (finished) {
              return
            }

            finished = true

            reject(
              makeError(
                'Interconnect connection timeout'
              )
            )
          },
          timeout
        )

        handshakeWaiters.push({
          resolve: function () {
            if (finished) {
              return
            }

            finished = true
            clearTimeout(timer)
            resolve()
          },

          reject: function (error) {
            if (finished) {
              return
            }

            finished = true
            clearTimeout(timer)
            reject(error)
          }
        })
      })
    }
  )
}

/* -------------------------------------------------------------------------- */
/* Handshake                                                                  */
/* -------------------------------------------------------------------------- */

function localCaps() {
  return {
    version: PROTOCOL_VERSION,

    chunk: true,

    maxChunkSize: DEFAULT_CHUNK_SIZE,

    /*
     * Important:
     *
     * Do not advertise deflate/lz4 here unless QuickApp implements the
     * corresponding decompression.
     */
    encodings: [
      'base64',
      'text'
    ],

    compressions: [],

    ack: true,

    ackWindow: DEFAULT_ACK_WINDOW,

    stream: true
  }
}

function resetHandshake() {
  handshakeReady = false
  handshakePromise = null

  negotiatedCaps = {
    version: 1,
    chunked: false,
    chunkSize: DEFAULT_CHUNK_SIZE,
    stream: false,
    ack: false,
    ackWindow: 0,
    encodings: [
      'base64',
      'text'
    ],
    compressions: []
  }
}

function settleHandshakeSuccess() {
  if (!handshakeReady) {
    handshakeReady = true
  }

  const waiters =
    handshakeWaiters.splice(
      0,
      handshakeWaiters.length
    )

  for (let i = 0; i < waiters.length; i++) {
    waiters[i].resolve()
  }
}

function settleHandshakeFailure(error) {
  const waiters =
    handshakeWaiters.splice(
      0,
      handshakeWaiters.length
    )

  for (let i = 0; i < waiters.length; i++) {
    waiters[i].reject(error)
  }
}

function applyPeerCaps(caps) {
  if (!caps || !isObject(caps)) {
    return
  }

  const version = clamp(
    caps.version || 1,
    1,
    PROTOCOL_VERSION
  )

  const chunked =
    version >= 2 &&
    caps.chunk === true

  const chunkSize = clamp(
    caps.maxChunkSize ||
      DEFAULT_CHUNK_SIZE,
    256,
    MAX_CHUNK_SIZE
  )

  const peerEncodings =
    Array.isArray(caps.encodings)
      ? caps.encodings
      : []

  const peerCompressions =
    Array.isArray(caps.compressions)
      ? caps.compressions
      : []

  const encodings = []

  /*
   * Preserve peer preference while limiting
   * to what QuickApp actually implements.
   */
  for (
    let i = 0;
    i < peerEncodings.length;
    i++
  ) {
    const encoding =
      String(peerEncodings[i])

    if (
      (
        encoding === 'base64' ||
        encoding === 'text'
      ) &&
      encodings.indexOf(
        encoding
      ) < 0
    ) {
      encodings.push(encoding)
    }
  }

  const ack =
    version >= 3 &&
    chunked &&
    caps.ack === true

  const ackWindow = ack
    ? clamp(
        caps.ackWindow ||
          DEFAULT_ACK_WINDOW,
        MIN_ACK_WINDOW,
        MAX_ACK_WINDOW
      )
    : 0

  const stream =
    version >= 4 &&
    chunked &&
    ack &&
    caps.stream === true

  negotiatedCaps = {
    version,

    chunked,

    chunkSize,

    stream,

    ack,

    ackWindow,

    encodings:

      encodings.length > 0
        ? encodings
        : [
            'base64',
            'text'
          ],

    /*
     * QuickApp deliberately negotiates no compression.
     */
    compressions: []
  }
}

async function sendHandshake(count) {
  await sendMessage({
    tag: '__hs__',

    count: count,

    caps: localCaps()
  })
}

function ensureHandshake() {
  if (handshakeReady) {
    return Promise.resolve()
  }

  if (handshakePromise) {
    return handshakePromise
  }

  handshakePromise =
    waitForConnection(
      HANDSHAKE_TIMEOUT
    )
      .then(function () {
        if (handshakeReady) {
          return
        }

        return sendHandshake(0)
      })
      .then(function () {
        /*
         * Important:
         *
         * Do NOT mark handshakeReady here.
         *
         * The request must wait for the peer's
         * __hs__ reply so codec/chunk/stream capabilities
         * are actually negotiated.
         */
        return new Promise(
          function (resolve, reject) {
            const timer =
              setTimeout(
                function () {
                  if (
                    !handshakeReady
                  ) {
                    reject(
                      makeError(
                        'FetchBridge handshake timeout'
                      )
                    )

                    settleHandshakeFailure(
                      makeError(
                        'FetchBridge handshake timeout'
                      )
                    )

                    handshakePromise =
                      null
                  }
                },
                HANDSHAKE_TIMEOUT
              )

            const poll =
              setInterval(
                function () {
                  if (handshakeReady) {
                    clearTimeout(
                      timer
                    )

                    clearInterval(
                      poll
                    )

                    resolve()
                  }
                },
                20
              )

            /*
             * Store a temporary waiter so the
             * handshake can resolve immediately.
             */
            handshakeWaiters.push({
              resolve:
                function () {
                  clearTimeout(
                    timer
                  )

                  clearInterval(
                    poll
                  )

                  resolve()
                },

              reject:
                function (
                  error
                ) {
                  clearTimeout(
                    timer
                  )

                  clearInterval(
                    poll
                  )

                  reject(error)
                }
            })
          }
        )
      })
      .catch(function (error) {
        handshakePromise = null
        throw error
      })

  return handshakePromise
}

/* -------------------------------------------------------------------------- */
/* HTTP response helpers                                                      */
/* -------------------------------------------------------------------------- */

function createMeta(resp) {
  resp = resp || {}

  return {
    ok: !!resp.ok,

    status: Number(
      resp.status || 0
    ),

    statusText:
      resp.statusText || '',

    headers:
      resp.headers || {},

    raw: !!resp.raw
  }
}

function getResponseEncoding(resp) {
  const encoding =
    resp.bodyEncoding

  if (encoding) {
    return String(
      encoding
    )
  }

  /*
   * Legacy protocol:
   * raw=true -> base64
   * raw=false -> text
   */
  return resp.raw
    ? 'base64'
    : 'text'
}

/* -------------------------------------------------------------------------- */
/* Normal response                                                            */
/* -------------------------------------------------------------------------- */

function handleNormalResponse(
  id,
  payload
) {
  const item = pending[id]

  if (!item) {
    return
  }

  const resp =
    payload &&
    payload.resp
      ? payload.resp
      : payload

  if (!resp) {
    rejectPending(
      id,
      makeError(
        'Invalid fetch response'
      )
    )

    return
  }

  let bytes

  try {
    const encoding =
      getResponseEncoding(
        resp
      )

    /*
     * Compression is intentionally unsupported
     * on the QuickApp side.
     */
    if (
      resp.compression &&
      resp.compression !== 'none'
    ) {
      throw new Error(
        'Unsupported response compression: ' +
        resp.compression
      )
    }

    bytes =
      decodeWireData(
        resp.body || '',
        encoding
      )
  } catch (error) {
    rejectPending(
      id,
      makeError(
        error.message
      )
    )

    return
  }

  const store =
    new ByteStore(
      bytes.length
    )

  store.push(bytes)

  const response =
    new Response(
      createMeta(resp),
      store,
      false
    )

  clearPendingTimer(id)

  delete pending[id]

  item.resolve(response)
}

/* -------------------------------------------------------------------------- */
/* Finite chunked response                                                    */
/* -------------------------------------------------------------------------- */

function handleChunkHeader(
  id,
  payload
) {
  const item = pending[id]

  if (!item) {
    return
  }

  const resp =
    payload &&
    payload.resp

  if (!resp) {
    rejectPending(
      id,
      makeError(
        'Invalid chunked response header'
      )
    )

    return
  }

  if (
    resp.compression &&
    resp.compression !== 'none'
  ) {
    rejectPending(
      id,
      makeError(
        'Unsupported response compression: ' +
        resp.compression
      )
    )

    return
  }

  item.kind = 'chunked'

  item.encoding =
    getResponseEncoding(
      resp
    )

  item.nextSeq = 0

  item.chunkCount =
    Number(
      resp.chunkCount || 0
    )

  item.totalBytes =
    Number(
      resp.totalBytes || 0
    )

  item.raw =
    !!resp.raw

  item.ackEnabled =
    resp.ack === true &&
    negotiatedCaps.ack

  item.store =
    new ByteStore(
      item.totalBytes
    )

  if (item.ackEnabled) {
    /*
     * Header itself does not need ACK.
     * Chunks are acknowledged with the next
     * expected contiguous sequence number.
     */
  }
}

async function sendFetchAck(
  id,
  ack
) {
  await sendMessage({
    tag: 'fetch-ack',

    id: id,

    ack: ack
  })
}

function handleChunk(
  id,
  payload
) {
  const item = pending[id]

  if (!item) {
    return
  }

  const seq = Number(
    payload.seq
  )

  if (seq !== item.nextSeq) {
    rejectPending(
      id,
      makeError(
        'Out-of-order fetch chunk: expected ' +
        item.nextSeq +
        ', got ' +
        seq
      )
    )

    return
  }

  let bytes

  try {
    bytes =
      decodeWireData(
        payload.data || '',
        item.encoding
      )
  } catch (error) {
    rejectPending(
      id,
      makeError(
        'Chunk decode failed: ' +
        error.message
      )
    )

    return
  }

  item.store.push(bytes)

  item.nextSeq += 1

  if (item.ackEnabled) {
    sendFetchAck(
      id,
      item.nextSeq
    ).catch(function (
      error
    ) {
      rejectPending(
        id,
        error
      )
    })
  }

  if (
    item.chunkCount > 0 &&
    item.nextSeq >=
      item.chunkCount
  ) {
    const response =
      new Response(
        {
          ok:
            item.meta.ok,

          status:
            item.meta.status,

          statusText:
            item.meta.statusText,

          headers:
            item.meta.headers,

          raw:
            item.meta.raw
        },

        item.store,

        false
      )

    clearPendingTimer(id)

    delete pending[id]

    item.resolve(
      response
    )
  }
}

/* -------------------------------------------------------------------------- */
/* v4 streaming response                                                      */
/* -------------------------------------------------------------------------- */

function handleStreamHeader(
  id,
  payload
) {
  const item = pending[id]

  if (!item) {
    return
  }

  const resp =
    payload &&
    payload.resp

  if (!resp) {
    rejectPending(
      id,
      makeError(
        'Invalid stream response header'
      )
    )

    return
  }

  if (
    resp.compression &&
    resp.compression !== 'none'
  ) {
    rejectPending(
      id,
      makeError(
        'Unsupported response compression: ' +
        resp.compression
      )
    )

    return
  }

  item.kind =
    'stream'

  item.encoding =
    getResponseEncoding(
      resp
    )

  item.nextSeq = 0
  item.nextOffset = 0

  item.totalBytes = Number(
    resp.contentLength ||
      resp.totalBytes ||
      0
  )

  item.store =
    item.buffer
      ? new ByteStore(
          item.totalBytes
        )
      : null

  item.meta =
    createMeta(resp)

  const response =
    new Response(
      item.meta,

      item.store,

      true
    )

  response._complete =
    false

  response._completionPromise =
    item.completePromise

  item.response =
    response

  clearPendingTimer(id)

  /*
   * For stream=true:
   *
   * resolve fetch() immediately after
   * the response header arrives.
   *
   * HTTP body continues asynchronously.
   */
  item.resolve(response)
  item.resolved = true
}

async function sendStreamAck(
  id,
  ack
) {
  await sendMessage({
    tag:
      'fetch-stream-ack',

    id: id,

    ack: ack
  })
}

function handleStreamFrame(
  id,
  payload
) {
  const item = pending[id]

  if (!item) {
    return
  }

  const seq = Number(
    payload.seq
  )

  const offset = Number(
    payload.offset
  )

  if (seq !== item.nextSeq) {
    failStream(
      id,
      'Out-of-order stream frame'
    )

    return
  }

  if (
    offset !== item.nextOffset
  ) {
    failStream(
      id,
      'Invalid stream offset'
    )

    return
  }

  let bytes

  try {
    /*
     * IMPORTANT:
     *
     * Every v4 stream frame is independently encoded.
     * Therefore we decode payload.data separately
     * for every frame.
     */
    bytes =
      decodeWireData(
        payload.data || '',
        item.encoding
      )
  } catch (error) {
    failStream(
      id,
      'Stream decode failed: ' +
        error.message
    )

    return
  }

  /*
   * Verify CRC32 if supplied.
   */
  if (payload.crc32) {
    const expected =
      String(
        payload.crc32
      ).toLowerCase()

    const actual =
      crc32(bytes)

    if (
      expected !== actual
    ) {
      failStream(
        id,
        'Stream CRC32 mismatch'
      )

      return
    }
  }

  const currentOffset =
    item.nextOffset

  item.nextSeq += 1

  item.nextOffset +=
    bytes.length

  if (item.buffer) {
    item.store.push(bytes)
  }

  if (
    typeof item.onChunk ===
      'function'
  ) {
    try {
      item.onChunk(
        bytes,
        currentOffset,
        Number(
          payload.totalBytes ||
            item.totalBytes ||
            0
        )
      )
    } catch (error) {
      /*
       * User callback errors must not corrupt
       * the transport state.
       */
    }
  }

  /*
   * ACK after successfully accepting the frame.
   */
  sendStreamAck(
    id,
    item.nextSeq
  ).catch(function (
    error
  ) {
    failStream(
      id,
      error.message
    )
  })

  if (
    payload.final === true
  ) {
    finishStream(
      id,
      Number(
        payload.totalBytes ||
          item.nextOffset
      )
    )
  }
}

function finishStream(
  id,
  totalBytes
) {
  const item = pending[id]

  if (!item) {
    return
  }

  if (
    totalBytes >= 0 &&
    totalBytes !==
      item.nextOffset
  ) {
    failStream(
      id,
      'Stream byte count mismatch'
    )

    return
  }

  if (item.response) {
    item.response._complete =
      true
  }

  if (item.completeResolve) {
    item.completeResolve()
  }

  /*
   * Keep the pending entry around only if the
   * Response needs to read the final buffered body.
   *
   * Since fetch() is already resolved for stream mode,
   * the transport record can now be removed.
   */
  if (item.resolved) {
    clearPendingTimer(id)

    delete pending[id]
  }
}

function failStream(
  id,
  message
) {
  const item = pending[id]

  if (!item) {
    return
  }

  const error =
    makeError(message)

  if (item.response) {
    item.response._complete =
      false
  }

  if (item.completeReject) {
    item.completeReject(
      error
    )
  }

  rejectPending(
    id,
    error
  )
}

/* -------------------------------------------------------------------------- */
/* Complete promise for streams                                               */
/* -------------------------------------------------------------------------- */

function createCompletionPromise(
  item
) {
  item.completePromise =
    new Promise(function (
      resolve,
      reject
    ) {
      item.completeResolve =
        resolve

      item.completeReject =
        reject
    })
}

/* -------------------------------------------------------------------------- */
/* Incoming message router                                                    */
/* -------------------------------------------------------------------------- */

function parseIncoming(data) {
  let value =
    data &&
    own(data, 'data')
      ? data.data
      : data

  if (
    typeof value === 'string'
  ) {
    try {
      value =
        JSON.parse(value)
    } catch (error) {
      return null
    }
  }

  if (!isObject(value)) {
    return null
  }

  return value
}

async function handleHandshake(
  message
) {
  const count =
    Number(
      message.count || 0
    )

  applyPeerCaps(
    message.caps
  )

  /*
   * FetchBridge handshake:
   *
   * count 0 -> reply 1
   * count 1 -> reply 2 and session is ready
   * count >=2 -> no reply
   */
  if (count < 2) {
    try {
      await sendHandshake(
        count + 1
      )
    } catch (error) {
      resetHandshake()

      settleHandshakeFailure(
        error
      )

      return
    }
  }

  /*
   * count > 0 means we have received the
   * peer side of the handshake and therefore
   * have usable negotiated capabilities.
   */
  if (count > 0) {
    settleHandshakeSuccess()
  }
}

function handleIncoming(
  message
) {
  const tag =
    message.tag

  if (!tag) {
    return
  }

  if (tag === '__hs__') {
    handleHandshake(
      message
    )

    return
  }

  const id =
    message.id != null
      ? String(message.id)
      : null

  if (
    tag === 'fetch'
  ) {
    if (!id) {
      return
    }

    const payload =
      message

    const resp =
      payload.resp

    if (
      resp &&
      resp.chunked === true
    ) {
      /*
       * v4 stream is announced by stream=true.
       */
      if (
        resp.stream === true
      ) {
        handleStreamHeader(
          id,
          payload
        )

        return
      }

      handleChunkHeader(
        id,
        payload
      )

      return
    }

    handleNormalResponse(
      id,
      payload
    )

    return
  }

  if (
    tag === 'fetch-chunk'
  ) {
    if (!id) {
      return
    }

    handleChunk(
      id,
      message
    )

    return
  }

  if (
    tag === 'fetch-stream'
  ) {
    if (!id) {
      return
    }

    handleStreamFrame(
      id,
      message
    )
  }
}

/* -------------------------------------------------------------------------- */
/* Connection events                                                          */
/* -------------------------------------------------------------------------- */

connect.onopen =
  function () {
    connectionOpen = true

    /*
     * Every reconnect is a new protocol session.
     */
    resetHandshake()

    /*
     * Resolve connection waiters first.
     * The next fetch() will trigger ensureHandshake().
     */
    const waiters =
      handshakeWaiters.splice(
        0,
        handshakeWaiters.length
      )

    for (
      let i = 0;
      i < waiters.length;
      i++
    ) {
      waiters[i].resolve()
    }
  }

connect.onclose =
  function (event) {
    connectionOpen = false

    resetHandshake()

    rejectAllPending(
      makeError(
        'Interconnect connection closed'
      )
    )

    settleHandshakeFailure(
      makeError(
        'Interconnect connection closed'
      )
    )
  }

connect.onerror =
  function (event) {
    /*
     * Keep the connection object alive.
     * Vela will report the eventual close/open state.
     */
  }

connect.onmessage =
  function (event) {
    const message =
      parseIncoming(event)

    if (!message) {
      return
    }

    handleIncoming(
      message
    )
  }

/* -------------------------------------------------------------------------- */
/* Request                                                                    */
/* -------------------------------------------------------------------------- */

function buildOptions(options) {
  options =
    options || {}

  const method =
    String(
      options.method || 'GET'
    ).toUpperCase()

  const headers =
    normalizeHeaders(
      options.headers
    )

  const body =
    encodeRequestBody(
      options.body
    )

  return {
    method,

    headers,

    body
  }
}

function clearPendingTimer(id) {
  const item = pending[id]

  if (!item) {
    return
  }

  if (item.timer) {
    clearTimeout(
      item.timer
    )

    item.timer = null
  }
}

function startPendingTimer(
  id,
  timeout
) {
  const item = pending[id]

  if (!item) {
    return
  }

  if (
    !timeout ||
    timeout <= 0
  ) {
    return
  }

  item.timer =
    setTimeout(
      function () {
        const current =
          pending[id]

        if (!current) {
          return
        }

        delete pending[id]

        if (
          current.completeReject
        ) {
          current.completeReject(
            makeError(
              'Fetch timeout'
            )
          )
        }

        current.reject(
          makeError(
            'Fetch timeout'
          )
        )
      },
      timeout
    )
}

/* -------------------------------------------------------------------------- */
/* Public fetch()                                                             */
/* -------------------------------------------------------------------------- */

export default async function fetch(
  url,
  options
) {
  url = String(url)

  options =
    options || {}

  await ensureHandshake()

  const id =
    options.id != null
      ? String(options.id)
      : nowId()

  const requestOptions =
    buildOptions(
      options
    )

  const isStream =
    options.stream === true

  const buffer =
    options.buffer !==
      undefined
      ? !!options.buffer
      : (
          isStream
            ? DEFAULT_STREAM_BUFFER
            : true
        )

  const timeout =
    Number(
      options.timeout || 0
    )

  const item = {
    id,

    resolve: null,
    reject: null,

    resolved: false,

    kind: null,

    meta: null,

    encoding: null,

    buffer,

    onChunk:
      typeof options.onChunk ===
        'function'
        ? options.onChunk
        : null,

    timer: null,

    nextSeq: 0,
    nextOffset: 0,

    chunkCount: 0,
    totalBytes: 0,

    store: null,

    response: null,

    completePromise: null,
    completeResolve: null,
    completeReject: null
  }

  const promise =
    new Promise(function (
      resolve,
      reject
    ) {
      item.resolve =
        resolve

      item.reject =
        reject
    })

  pending[id] = item

  /*
   * A stream response may resolve fetch()
   * immediately at the header stage, while
   * the body continues arriving.
   */
  if (isStream) {
    createCompletionPromise(
      item
    )
  }

  startPendingTimer(
    id,
    timeout
  )

  const message = {
    tag: 'fetch',

    id: id,

    url: url,

    options: {
      method:
        requestOptions.method,

      headers:
        requestOptions.headers,

      body:
        requestOptions.body,

      raw:
        options.raw === true,

      stream:
        isStream,

      followRedirects:
        options.followRedirects === true,

      fixedChunks:
        options.fixedChunks === true
    }
  }

  try {
    await sendMessage(
      message
    )
  } catch (error) {
    clearPendingTimer(id)

    delete pending[id]

    throw error
  }

  return promise
}

/* -------------------------------------------------------------------------- */
/* Optional helpers                                                           */
/* -------------------------------------------------------------------------- */

export function getInterconnectState() {
  return connectionOpen
}

export function getNegotiatedCaps() {
  return {
    version:
      negotiatedCaps.version,

    chunked:
      negotiatedCaps.chunked,

    chunkSize:
      negotiatedCaps.chunkSize,

    stream:
      negotiatedCaps.stream,

    ack:
      negotiatedCaps.ack,

    ackWindow:
      negotiatedCaps.ackWindow,

    encodings:
      negotiatedCaps.encodings.slice(),

    compressions:
      negotiatedCaps.compressions.slice()
  }
}