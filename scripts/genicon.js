// Dependency-free PNG icon generator for miDash (RGBA, 8-bit, color type 6).
// Draws a full-bleed brand-green square with a 2x2 grid of rounded "card" tiles —
// reads as a dashboard, works as a maskable icon (full bleed) and an iOS icon
// (iOS rounds the corners itself).
const zlib = require("zlib");
const fs = require("fs");

// CRC32 (PNG chunk checksum)
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return (buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
})();
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(CRC(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function png(size, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  // raw scanlines, filter byte 0 per row
  const raw = Buffer.alloc((size * 4 + 1) * size);
  let o = 0;
  for (let y = 0; y < size; y++) { raw[o++] = 0; for (let x = 0; x < size; x++) { const i = (y * size + x) * 4; raw[o++] = rgba[i]; raw[o++] = rgba[i + 1]; raw[o++] = rgba[i + 2]; raw[o++] = rgba[i + 3]; } }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

// rounded-rect coverage at pixel center (px,py) for rect [x0,x1]x[y0,y1], radius r
function cover(px, py, x0, y0, x1, y1, r) {
  if (px < x0 - 0.5 || px > x1 + 0.5 || py < y0 - 0.5 || py > y1 + 0.5) return 0;
  let dx = 0, dy = 0;
  if (px < x0 + r) dx = (x0 + r) - px; else if (px > x1 - r) dx = px - (x1 - r);
  if (py < y0 + r) dy = (y0 + r) - py; else if (py > y1 - r) dy = py - (y1 - r);
  if (dx === 0 || dy === 0) return 1;                 // edges (not corner) fully covered
  const d = Math.hypot(dx, dy);
  return Math.max(0, Math.min(1, r - d + 0.5));        // smooth AA at the rounded corner
}
function blend(rgba, i, r, g, b, a) {
  const ia = 1 - a;
  rgba[i] = Math.round(r * a + rgba[i] * ia);
  rgba[i + 1] = Math.round(g * a + rgba[i + 1] * ia);
  rgba[i + 2] = Math.round(b * a + rgba[i + 2] * ia);
  rgba[i + 3] = 255;
}

function draw(size) {
  const rgba = new Uint8Array(size * 4 * size);
  // background: brand green (#2d6a4f), full bleed
  for (let i = 0; i < size * size; i++) { rgba[i * 4] = 45; rgba[i * 4 + 1] = 106; rgba[i * 4 + 2] = 79; rgba[i * 4 + 3] = 255; }
  // 2x2 grid of tiles inside a safe zone (so a maskable crop never clips them)
  const m = size * 0.215;            // outer margin (safe zone)
  const gap = size * 0.075;
  const area = size - 2 * m;
  const ts = (area - gap) / 2;       // tile size
  const r = ts * 0.22;               // tile corner radius
  const tiles = [
    [m, m, 168, 230, 207],                       // top-left: mint accent (#a8e6cf)
    [m + ts + gap, m, 245, 245, 242],            // others: warm white
    [m, m + ts + gap, 245, 245, 242],
    [m + ts + gap, m + ts + gap, 245, 245, 242],
  ];
  for (const [tx, ty, cr, cg, cb] of tiles) {
    const x0 = tx, y0 = ty, x1 = tx + ts, y1 = ty + ts;
    const px0 = Math.max(0, Math.floor(x0 - 1)), px1 = Math.min(size - 1, Math.ceil(x1 + 1));
    const py0 = Math.max(0, Math.floor(y0 - 1)), py1 = Math.min(size - 1, Math.ceil(y1 + 1));
    for (let y = py0; y <= py1; y++) for (let x = px0; x <= px1; x++) {
      const a = cover(x + 0.5, y + 0.5, x0, y0, x1, y1, r);
      if (a > 0) blend(rgba, (y * size + x) * 4, cr, cg, cb, a);
    }
  }
  return rgba;
}

for (const s of [192, 512, 180]) {
  const name = s === 180 ? "apple-touch-icon.png" : `icon-${s}.png`;
  fs.writeFileSync(process.argv[2] + "/" + name, png(s, draw(s)));
  console.log("wrote", name);
}
