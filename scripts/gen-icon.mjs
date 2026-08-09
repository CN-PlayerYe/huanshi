// 生成应用图标:水墨风 256x256 PNG → 打包为 ICO(供 electron-builder 使用)
// 宣纸底 + 墨色远山近山 + 朱砂印,中国风水墨
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "build");
mkdirSync(outDir, { recursive: true });

const SIZE = 256;

// ---- 像素绘制 ----
function drawPixel(x, y) {
  // 宣纸底(带极淡的竖向渐变)
  const t = y / SIZE;
  const paper = [lerp(0xf6, 0xec, t * 0.8), lerp(0xf1, 0xe5, t * 0.8), lerp(0xe4, 0xd6, t * 0.8)];

  // 远山(浅墨):正弦山脊
  const farRidge = 168 - 46 * Math.abs(Math.sin((x + 20) / 88));
  // 近山(深墨)
  const nearRidge = 196 - 72 * Math.abs(Math.sin((x + 55) / 118));

  // 朱砂印(右上角)
  const sealD = Math.hypot(x - 200, y - 54);

  let color = paper;
  if (y >= farRidge) color = [0x8a, 0x82, 0x6c];
  if (y >= nearRidge) color = [0x45, 0x41, 0x34];
  if (sealD < 16) color = [0xb0, 0x3a, 0x2e];
  if (sealD < 8) color = [0xf2, 0xed, 0xdf]; // 印心留白
  // 山与纸的柔和过渡(简易抗锯齿)
  if (Math.abs(y - farRidge) < 2) color = mix(paper, [0x8a, 0x82, 0x6c], (2 - Math.abs(y - farRidge)) / 2);
  if (Math.abs(y - nearRidge) < 2 && y >= nearRidge - 2) color = mix([0x8a, 0x82, 0x6c], [0x45, 0x41, 0x34], (2 - Math.abs(y - nearRidge)) / 2);

  return [Math.round(color[0]), Math.round(color[1]), Math.round(color[2]), 255];
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}
function mix(a, b, t) {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

// ---- PNG 编码 ----
function crc32(buf) {
  let c, table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let p = 0;
  for (let y = 0; y < size; y++) {
    raw[p++] = 0; // filter: None
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = drawPixel(x, y);
      raw[p++] = r;
      raw[p++] = g;
      raw[p++] = b;
      raw[p++] = a;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- ICO 封装(256 + 48 + 32 + 16) ----
const pngs = [256, 48, 32, 16].map((s) => encodePNG(s));
const count = pngs.length;
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(count, 4);
const entries = [];
let offset = 6 + count * 16;
pngs.forEach((png, i) => {
  const s = [256, 48, 32, 16][i];
  const e = Buffer.alloc(16);
  e[0] = s === 256 ? 0 : s;
  e[1] = s === 256 ? 0 : s;
  e.writeUInt16LE(1, 4); // planes
  e.writeUInt16LE(32, 6); // bpp
  e.writeUInt32LE(png.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += png.length;
  entries.push(e);
});
const ico = Buffer.concat([header, ...entries, ...pngs]);
writeFileSync(join(outDir, "icon.ico"), ico);
writeFileSync(join(outDir, "icon.png"), pngs[0]);
console.log(`已生成 build/icon.ico(${(ico.length / 1024).toFixed(1)}KB)与 build/icon.png`);
