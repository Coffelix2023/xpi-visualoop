import { inflateSync } from "node:zlib";

// Minimal PNG reader for non-interlaced 8-bit gray/RGB/RGBA (what Chrome emits).
export function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error("not a png");
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  let bitDepth = 0;
  let interlace = 0;
  const data = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("latin1");
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8];
      colorType = body[9];
      interlace = body[12];
    } else if (type === "IDAT") data.push(body);
    else if (type === "IEND") break;
    offset += length + 12;
  }
  if (bitDepth !== 8 || interlace !== 0) throw new Error("unsupported png");
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
  if (!channels) throw new Error(`unsupported color type ${colorType}`);
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  let cursor = 0;
  for (let row = 0; row < height; row += 1) {
    const filter = raw[cursor];
    cursor += 1;
    const line = raw.subarray(cursor, cursor + stride);
    cursor += stride;
    const target = pixels.subarray(row * stride, (row + 1) * stride);
    const prior = row === 0 ? Buffer.alloc(stride) : pixels.subarray((row - 1) * stride, row * stride);
    for (let index = 0; index < stride; index += 1) {
      const left = index >= channels ? target[index - channels] : 0;
      const up = prior[index];
      const upLeft = index >= channels ? prior[index - channels] : 0;
      const value = line[index];
      if (filter === 0) target[index] = value;
      else if (filter === 1) target[index] = (value + left) & 0xff;
      else if (filter === 2) target[index] = (value + up) & 0xff;
      else if (filter === 3) target[index] = (value + ((left + up) >> 1)) & 0xff;
      else {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        const pr = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
        target[index] = (value + pr) & 0xff;
      }
    }
  }
  return {
    channels,
    height,
    pixel(x, y) {
      const base = y * stride + x * channels;
      return [pixels[base], pixels[base + 1] ?? pixels[base], pixels[base + 2] ?? pixels[base]];
    },
    width,
  };
}
