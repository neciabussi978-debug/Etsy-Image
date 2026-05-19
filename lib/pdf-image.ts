import { deflateSync, inflateSync } from "zlib";

type PdfImage = {
  width: number;
  height: number;
  colorSpace: "/DeviceRGB";
  bitsPerComponent: 8;
  filter: "/DCTDecode" | "/FlateDecode";
  data: Buffer;
};

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function isJpeg(buf: Buffer): boolean {
  return buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8;
}

function jpegSize(buf: Buffer): { width: number; height: number } {
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) break;
    const marker = buf[offset + 1];
    const len = buf.readUInt16BE(offset + 2);
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      return {
        height: buf.readUInt16BE(offset + 5),
        width: buf.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + len;
  }
  throw new Error("无法读取 JPEG 尺寸");
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePngToRgb(buf: Buffer): PdfImage {
  if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("不是有效的 PNG 图片");
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
      const compression = data[10];
      const filter = data[11];
      const interlace = data[12];
      if (bitDepth !== 8 || compression !== 0 || filter !== 0 || interlace !== 0) {
        throw new Error("PDF 导出暂不支持该 PNG 编码");
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
    throw new Error("PDF 导出暂只支持灰度/RGB/RGBA PNG");
  }

  const inflated = inflateSync(Buffer.concat(idat));
  const rowBytes = width * channels;
  const rgb = Buffer.alloc(width * height * 3);
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
      else if (filter !== 0) throw new Error("PDF 导出暂不支持该 PNG 滤镜");
    }

    for (let x = 0; x < width; x++) {
      const p = x * channels;
      if (channels === 1) {
        rgb[dst++] = row[p];
        rgb[dst++] = row[p];
        rgb[dst++] = row[p];
      } else {
        rgb[dst++] = row[p];
        rgb[dst++] = row[p + 1];
        rgb[dst++] = row[p + 2];
      }
    }
    prev = row;
  }

  return {
    width,
    height,
    colorSpace: "/DeviceRGB",
    bitsPerComponent: 8,
    filter: "/FlateDecode",
    data: deflateSync(rgb),
  };
}

function pdfEscapeBytes(buf: Buffer): string {
  return buf.toString("binary");
}

function buildPdf(image: PdfImage): Buffer {
  const dpi = 300;
  const pageWidth = Math.max(72, (image.width / dpi) * 72);
  const pageHeight = Math.max(72, (image.height / dpi) * 72);
  const content = `q\n${pageWidth.toFixed(3)} 0 0 ${pageHeight.toFixed(3)} 0 0 cm\n/Im0 Do\nQ\n`;

  const objects = [
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`,
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth.toFixed(3)} ${pageHeight.toFixed(3)}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`,
    `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace ${image.colorSpace} /BitsPerComponent ${image.bitsPerComponent} /Filter ${image.filter} /Length ${image.data.length} >>\nstream\n${pdfEscapeBytes(image.data)}\nendstream`,
    `<< /Length ${Buffer.byteLength(content, "binary")} >>\nstream\n${content}endstream`,
  ];

  let pdf = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf, "binary"));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf, "binary");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i < offsets.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "binary");
}

export function imageBufferToSinglePagePdf(buf: Buffer): Buffer {
  if (isJpeg(buf)) {
    const size = jpegSize(buf);
    return buildPdf({
      ...size,
      colorSpace: "/DeviceRGB",
      bitsPerComponent: 8,
      filter: "/DCTDecode",
      data: buf,
    });
  }
  return buildPdf(decodePngToRgb(buf));
}
