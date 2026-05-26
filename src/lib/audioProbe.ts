/**
 * 音频时长解析
 *
 * 不依赖 ffmpeg/ffprobe（很多用户机器没装），用纯 JS 解析常见格式的头：
 *   - WAV：固定头格式，sampleRate/byteRate 计算
 *   - MP3：扫描 frame 个数 × frame 时长
 *   - M4A/MP4：扫 mvhd box 拿 duration / timescale
 *
 * 返回秒数；解析失败返回 null。
 */

export async function probeAudioDuration(buf: Buffer, mime: string): Promise<number | null> {
  try {
    if (mime.includes("wav") || isRiff(buf)) return parseWav(buf);
    if (mime.includes("mp4") || mime.includes("m4a") || mime.includes("aac") || isMp4(buf))
      return parseMp4(buf);
    if (mime.includes("mpeg") || mime.includes("mp3") || isMp3(buf)) return parseMp3(buf);
    return null;
  } catch {
    return null;
  }
}

function isRiff(b: Buffer) {
  return b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WAVE";
}
function isMp4(b: Buffer) {
  return b.length > 12 && b.toString("ascii", 4, 8) === "ftyp";
}
function isMp3(b: Buffer) {
  if (b.length < 3) return false;
  // ID3 tag or MPEG sync
  return (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0);
}

// ----- WAV -----
function parseWav(b: Buffer): number | null {
  if (!isRiff(b)) return null;
  // 找 fmt 和 data chunk
  let p = 12;
  let sampleRate = 0;
  let byteRate = 0;
  let dataSize = 0;
  while (p + 8 <= b.length) {
    const id = b.toString("ascii", p, p + 4);
    const size = b.readUInt32LE(p + 4);
    if (id === "fmt ") {
      sampleRate = b.readUInt32LE(p + 12);
      byteRate = b.readUInt32LE(p + 16);
    } else if (id === "data") {
      dataSize = size;
      break;
    }
    p += 8 + size;
  }
  if (byteRate > 0 && dataSize > 0) return dataSize / byteRate;
  if (sampleRate > 0 && dataSize > 0) return dataSize / (sampleRate * 2); // 16bit mono 兜底
  return null;
}

// ----- MP4 / M4A -----
function parseMp4(b: Buffer): number | null {
  // 递归搜 mvhd box
  function scan(start: number, end: number): number | null {
    let p = start;
    while (p + 8 <= end) {
      let size = b.readUInt32BE(p);
      const type = b.toString("ascii", p + 4, p + 8);

      // size=0 表示这是最后一个 box，延伸到 end
      if (size === 0) {
        size = end - p;
      }
      // size=1 表示使用 extended size（8 字节后跟 8 字节大整数）
      if (size === 1) {
        if (p + 16 > end) return null;
        const hi = b.readUInt32BE(p + 8);
        const lo = b.readUInt32BE(p + 12);
        size = hi * 0x100000000 + lo;
      }

      // size 仍太小则跳过此 box（至少 8 字节头）
      if (size < 8) {
        p += 8;
        continue;
      }

      const boxEnd = Math.min(p + size, end);

      if (type === "mvhd") {
        const version = b[p + 8];
        if (version === 0) {
          const timescale = b.readUInt32BE(p + 20);
          const duration = b.readUInt32BE(p + 24);
          return timescale > 0 ? duration / timescale : null;
        } else {
          const timescale = b.readUInt32BE(p + 28);
          const durationHi = b.readUInt32BE(p + 32);
          const durationLo = b.readUInt32BE(p + 36);
          const duration = durationHi * 0x100000000 + durationLo;
          return timescale > 0 ? duration / timescale : null;
        }
      }
      // 容器型 box，递归
      if (["moov", "trak", "mdia", "minf", "udta", "meta"].includes(type)) {
        // meta box 的 fullbox header 多 4 字节
        const offset = type === "meta" ? 12 : 8;
        const r = scan(p + offset, boxEnd);
        if (r !== null) return r;
      }
      // size=0 时无法继续，退出
      if (size === end - p) break;
      p = boxEnd;
    }
    return null;
  }
  return scan(0, b.length);
}

// ----- MP3 -----
function parseMp3(b: Buffer): number | null {
  let p = 0;
  // 跳过 ID3v2 tag
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) {
    const tagSize =
      ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
    p = 10 + tagSize;
  }
  let totalDuration = 0;
  let frameCount = 0;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff || (b[p + 1] & 0xe0) !== 0xe0) break;
    const versionBits = (b[p + 1] >> 3) & 0x3;
    const layerBits = (b[p + 1] >> 1) & 0x3;
    const bitrateIdx = (b[p + 2] >> 4) & 0xf;
    const sampleIdx = (b[p + 2] >> 2) & 0x3;
    const padding = (b[p + 2] >> 1) & 0x1;
    const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5;
    const layer = 4 - layerBits;
    if (layer !== 3) break; // 只处理 Layer III
    const bitrate = mp3BitrateTable(version, bitrateIdx);
    const sampleRate = mp3SampleRateTable(version, sampleIdx);
    if (!bitrate || !sampleRate) break;
    const samplesPerFrame = version === 1 ? 1152 : 576;
    const frameSize = Math.floor((samplesPerFrame * bitrate * 1000) / 8 / sampleRate) + padding;
    if (frameSize < 4) break;
    totalDuration += samplesPerFrame / sampleRate;
    frameCount += 1;
    p += frameSize;
    if (frameCount > 200000) break; // 防御
  }
  return frameCount > 0 ? totalDuration : null;
}

function mp3BitrateTable(version: number, idx: number): number | null {
  const v1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, null];
  const v2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, null];
  const t = version === 1 ? v1 : v2;
  return t[idx] ?? null;
}
function mp3SampleRateTable(version: number, idx: number): number | null {
  if (version === 1) return [44100, 48000, 32000, null][idx] ?? null;
  if (version === 2) return [22050, 24000, 16000, null][idx] ?? null;
  return [11025, 12000, 8000, null][idx] ?? null;
}
