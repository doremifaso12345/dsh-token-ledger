/**
 * dsh-token-ledger — zstd 多帧读取器。
 *
 * DSH 的会话日志是「每批追加一帧 zstd」的容器，不是单个 zstd 流：
 * Node 的 `zlib.createZstdDecompress` 在拼接帧上只解出第一帧，
 * 因此流式解压在真实日志上会静默丢掉后续所有事件（实测：4.6MB、20 个会话，
 * 流式只得到 1 行，逐帧得到 636 行）。
 *
 * 这里按 Zstandard 帧头规格精确切分帧边界，不靠 magic 扫描：
 * magic 的 4 字节序列可能出现在压缩载荷内部，扫描法会把一帧切断。
 *
 * 帧布局：Magic(4) | Frame_Header_Descriptor(1) | Window_Descriptor(0/1)
 *        | Dictionary_ID(0/1/2/4) | Frame_Content_Size(0/1/2/4/8) | Blocks...
 * 每个 Block 头部 3 字节（小端）：bit0=Last_Block，bit1-2=Block_Type，bit3-23=Block_Size。
 */

import zlib from 'node:zlib'

/**
 * 本插件对 Node.js 的版本要求。
 *
 * 会话日志是多帧 zstd 容器，解压依赖 `zlib.zstdDecompressSync`：
 * 该 API 于 **Node 23.8.0** 上游加入，并回移到 **22.15.0 LTS**，
 * 因此 **23.0–23.7 这段区间没有它** —— 范围不是简单的 `>=22`。
 *
 * 必须显式探测：缺少它时逐帧解压会抛 TypeError，而解压循环把异常当作
 * 「坏帧」跳过，结果会**静默返回空数据**（仪表盘全 0，看上去像没用量）。
 * 这比直接报错更难排查，所以这里探测并在上层明确报出。
 */
export const NODE_REQUIREMENT = '^22.15.0 || >=23.8.0'

/** 当前运行环境是否提供 zstd 解压。 */
export const ZSTD_AVAILABLE = typeof zlib.zstdDecompressSync === 'function'

const ZSTD_MAGIC = 0xfd2fb528 // 小端写出为 28 B5 2F FD

/** Dictionary_ID_field_size 表，按 FHD 的 DID 标志位索引（字节数）。 */
const DID_SIZE = [0, 1, 2, 4]

/**
 * 从 `start` 处解析一个 zstd 帧的长度。
 * @param {Buffer} buf 完整缓冲区
 * @param {number} start 帧起始偏移（必须是 magic 处）
 * @returns {{frameEnd:number, blockCount:number}|null} 帧结束偏移；不是合法帧时返回 null
 */
export function measureFrame(buf, start) {
  if (start + 5 > buf.length) return null
  if (buf.readUInt32LE(start) !== ZSTD_MAGIC) return null

  const fhd = buf.readUInt8(start + 4)
  // RFC 8878 Frame_Header_Descriptor 位序：
  //   bit7-6 Frame_Content_Size_flag | bit5 Single_Segment_flag
  //   bit4 Unused | bit3 Reserved | bit2 Content_Checksum_flag | bit1-0 Dictionary_ID_flag
  const fcsFlag = (fhd >> 6) & 0b11
  const singleSegment = (fhd >> 5) & 1
  const checksum = (fhd >> 2) & 1
  const didFlag = fhd & 0b11

  let p = start + 5
  // Window_Descriptor 仅在非 Single_Segment 帧中存在
  if (singleSegment === 0) p += 1
  p += DID_SIZE[didFlag]
  // Frame_Content_Size 宽度由 fcsFlag 决定；fcsFlag=0 时，仅 Single_Segment 帧有 1 字节
  if (fcsFlag === 0) p += singleSegment === 1 ? 1 : 0
  else p += [0, 2, 4, 8][fcsFlag]

  if (p > buf.length) return null

  let blocks = 0
  while (true) {
    if (p + 3 > buf.length) return null
    const header = buf.readUInt8(p) | (buf.readUInt8(p + 1) << 8) | (buf.readUInt8(p + 2) << 16)
    const last = header & 1
    const type = (header >> 1) & 0b11
    const size = header >> 3
    p += 3
    // type: 0=Raw 1=RLE 2=Compressed 3=Reserved
    if (type === 0 || type === 2) p += size
    else if (type === 1) p += 1
    else return null
    blocks += 1
    if (p > buf.length) return null
    if (last === 1) break
    if (blocks > 1_000_000) return null // 异常防御：不可能有这么多块
  }

  if (checksum === 1) p += 4
  if (p > buf.length) return null
  return { frameEnd: p, blockCount: blocks }
}

/**
 * 把多帧 zstd 容器切成帧边界列表。
 * 遇到无法解析的字节则停止——宁可少读尾部，也不产出错位的数据。
 * @param {Buffer} buf 完整文件内容
 * @returns {Array<{start:number,end:number}>}
 */
export function splitFrames(buf) {
  const frames = []
  let p = 0
  while (p + 4 <= buf.length) {
    if (buf.readUInt32LE(p) !== ZSTD_MAGIC) break
    const m = measureFrame(buf, p)
    if (m === null) break
    frames.push({ start: p, end: m.frameEnd })
    p = m.frameEnd
  }
  return frames
}

/**
 * 解压多帧 zstd 容器并逐行回调。
 * 单帧损坏只跳过该帧，不影响其余帧——日志尾部可能正在被写入。
 *
 * 但「环境没有 zstd」不属于单帧损坏：那样每一帧都会失败并被记成坏帧，
 * 调用方只会看到 0 行数据。因此这里先探测，缺失时抛出明确错误。
 * @param {Buffer} buf 完整文件内容
 * @param {(line:string)=>void} onLine 每行原始文本
 * @returns {{lines:number, frames:number, badFrames:number, trailingBytes:number}}
 * @throws {Error} 运行环境缺少 `zlib.zstdDecompressSync` 时
 */
export function readZstdLines(buf, onLine) {
  if (!ZSTD_AVAILABLE) {
    throw new Error(
      `dsh-token-ledger: this Node.js build has no zlib.zstdDecompressSync, so multi-frame zstd ` +
        `session logs cannot be read. Node ${NODE_REQUIREMENT} is required ` +
        `(running ${process.version}). Refusing to silently report zero usage.`
    )
  }
  const frames = splitFrames(buf)
  let lines = 0
  let badFrames = 0

  for (const { start, end } of frames) {
    let text
    try {
      text = zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8')
    } catch {
      badFrames += 1
      continue
    }
    let from = 0
    while (from <= text.length) {
      const nl = text.indexOf('\n', from)
      const line = nl === -1 ? text.slice(from) : text.slice(from, nl)
      if (line.trim().length > 0) {
        onLine(line)
        lines += 1
      }
      if (nl === -1) break
      from = nl + 1
    }
  }

  const consumed = frames.length === 0 ? 0 : frames[frames.length - 1].end
  return { lines, frames: frames.length, badFrames, trailingBytes: buf.length - consumed }
}
