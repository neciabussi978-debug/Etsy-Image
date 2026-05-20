import { deflateSync, inflateSync } from "zlib";

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  typeBuf.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 8 + data.length);
  return out;
}

export function whiteToTransparentPng(buf: Buffer): Buffer {
  if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("透明 PNG 导出只支持 PNG 源图。请先生成/下载 PNG 结果。");
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];

  while (offset + 8 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString("ascii");
    const data = buf.subarray(offset + 8, offset + 8 + len);
    offset += 12 + len;

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (bitDepth !== 8 || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) {
        throw new Error("透明 PNG 导出暂不支持该 PNG 编码。");
      }
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
  }

  const channels =
    colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
  if (!width || !height || channels === 0) {
    throw new Error("透明 PNG 导出暂只支持灰度/RGB/RGBA PNG。");
  }

  const inflated = inflateSync(Buffer.concat(idat));
  const rowBytes = width * channels;
  const rgbaRows = Buffer.alloc((width * 4 + 1) * height);
  let src = 0;
  let dst = 0;
  let prev = Buffer.alloc(rowBytes);

  for (let y = 0; y < height; y++) {
    const filter = inflated[src++];
    const row = Buffer.from(inflated.subarray(src, src + rowBytes));
    src += rowBytes;

    for (let x = 0; x < rowBytes; x++) {
      const left = x >= channels ? row[x - channels] : 0;
      const up = prev[x] ?? 0;
      const upLeft = x >= channels ? prev[x - channels] ?? 0 : 0;
      if (filter === 1) row[x] = (row[x] + left) & 0xff;
      else if (filter === 2) row[x] = (row[x] + up) & 0xff;
      else if (filter === 3) row[x] = (row[x] + Math.floor((left + up) / 2)) & 0xff;
      else if (filter === 4) row[x] = (row[x] + paeth(left, up, upLeft)) & 0xff;
      else if (filter !== 0) throw new Error("透明 PNG 导出暂不支持该 PNG 滤镜。");
    }

    rgbaRows[dst++] = 0;
    for (let x = 0; x < width; x++) {
      const p = x * channels;
      const r = channels === 1 ? row[p] : row[p];
      const g = channels === 1 ? row[p] : row[p + 1];
      const b = channels === 1 ? row[p] : row[p + 2];
      const originalAlpha = channels === 4 ? row[p + 3] : 255;
      const whiteness = Math.min(r, g, b);
      const colorSpread = Math.max(r, g, b) - Math.min(r, g, b);
      const bgAlpha =
        whiteness >= 252 && colorSpread <= 8
          ? 0
          : whiteness >= 242 && colorSpread <= 12
            ? Math.round(((252 - whiteness) / 10) * originalAlpha)
            : originalAlpha;
      rgbaRows[dst++] = r;
      rgbaRows[dst++] = g;
      rgbaRows[dst++] = b;
      rgbaRows[dst++] = Math.max(0, Math.min(originalAlpha, bgAlpha));
    }
    prev = row;
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(rgbaRows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
