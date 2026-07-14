/**
 * Convert card art to webp + generate approximate PBR maps
 * (height from luminance, roughness from gold detection, normal from sobel)
 */
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const IMG = path.join(
  process.env.HOME,
  '.grok/sessions/%2FUsers%2Fhua%2FDocuments%2Fvhost%2Ftarot/019f60b8-5259-7422-8dde-c26b0441f13f/images'
);
const OUT = path.join(ROOT, 'public/assets');
const CARDS = path.join(OUT, 'cards');

fs.mkdirSync(CARDS, { recursive: true });

// source image id -> slug
const MAP = {
  '3.jpg': 'nuwa',
  '4.jpg': 'wukong',
  '5.jpg': 'change',
  '8.jpg': 'guanyin',
  '6.jpg': 'nezha',
  '7.jpg': 'pangu',
  '10.jpg': 'baisuzhen',
  '11.jpg': 'houyi',
  '9.jpg': 'longwang',
  '2.jpg': 'cardBack',
  '1.jpg': 'bg',
};

const CARD_W = 1024;
const CARD_H = 1580;

function sobelNormal(heightGray, w, h) {
  // heightGray: Uint8Array length w*h
  const out = Buffer.alloc(w * h * 3);
  const strength = 2.8;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const xm = Math.max(0, x - 1);
      const xp = Math.min(w - 1, x + 1);
      const ym = Math.max(0, y - 1);
      const yp = Math.min(h - 1, y + 1);
      // sobel
      const tl = heightGray[ym * w + xm];
      const t = heightGray[ym * w + x];
      const tr = heightGray[ym * w + xp];
      const l = heightGray[y * w + xm];
      const r = heightGray[y * w + xp];
      const bl = heightGray[yp * w + xm];
      const b = heightGray[yp * w + x];
      const br = heightGray[yp * w + xp];
      const dx = (tr + 2 * r + br) - (tl + 2 * l + bl);
      const dy = (bl + 2 * b + br) - (tl + 2 * t + tr);
      let nx = -dx * strength / 255;
      let ny = -dy * strength / 255;
      let nz = 1.0;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      const o = i * 3;
      out[o] = Math.round((nx * 0.5 + 0.5) * 255);
      out[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      out[o + 2] = Math.round((nz * 0.5 + 0.5) * 255);
    }
  }
  return out;
}

async function processDiffuse(srcPath, slug, isCard) {
  const img = sharp(srcPath).ensureAlpha();
  const meta = await img.metadata();

  let pipeline = sharp(srcPath).ensureAlpha().rotate();
  if (isCard) {
    pipeline = pipeline.resize(CARD_W, CARD_H, { fit: 'cover', position: 'centre' });
  } else if (slug === 'bg') {
    pipeline = pipeline.resize(2048, 1440, { fit: 'cover', position: 'centre' });
  }

  const { data, info } = await pipeline
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width;
  const h = info.height;
  const ch = info.channels; // 4
  const n = w * h;

  const heightGray = new Uint8Array(n);
  const roughGray = Buffer.alloc(n * 3);
  const diffuseRgba = Buffer.from(data);

  for (let i = 0; i < n; i++) {
    const o = i * ch;
    const r = data[o];
    const g = data[o + 1];
    const b = data[o + 2];
    const a = ch === 4 ? data[o + 3] : 255;

    // luminance
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;

    // gold-ish: high R+G, lower B, elevated saturation
    const maxc = Math.max(r, g, b);
    const minc = Math.min(r, g, b);
    const sat = maxc === 0 ? 0 : (maxc - minc) / maxc;
    const isGold = r > 120 && g > 90 && r > b + 20 && sat > 0.18;
    const isWarm = r > 160 && g > 60 && g < 160 && b < 100; // coral sun

    // height: raised gold linework + midform from lum
    let ht = lum * 0.55;
    if (isGold) ht = Math.min(255, ht + 90);
    if (isWarm) ht = Math.min(255, ht + 40);
    // frame edges slightly raised
    const px = i % w;
    const py = (i / w) | 0;
    const edge = Math.min(px, py, w - 1 - px, h - 1 - py);
    if (edge < 18) ht = Math.min(255, ht + 35);
    heightGray[i] = ht | 0;

    // roughness: gold = shiny (low), matte paint = high
    let rough = 0.72;
    if (isGold) rough = 0.18;
    else if (isWarm) rough = 0.35;
    else if (lum < 40) rough = 0.85;
    else if (lum > 180) rough = 0.45;
    const rv = Math.round(rough * 255);
    roughGray[i * 3] = rv;
    roughGray[i * 3 + 1] = rv;
    roughGray[i * 3 + 2] = rv;

    // keep alpha for transparent corners if any
    if (a < 10) {
      heightGray[i] = 0;
      roughGray[i * 3] = 255;
      roughGray[i * 3 + 1] = 255;
      roughGray[i * 3 + 2] = 255;
    }
  }

  const normalRgb = sobelNormal(heightGray, w, h);

  const baseName = slug === 'cardBack' ? 'cardBack' : slug === 'bg' ? 'bg' : slug;
  const outDir = slug === 'bg' ? OUT : CARDS;
  const diffuseName = slug === 'bg' ? 'bg.webp' : `${baseName}.webp`;

  // write diffuse
  await sharp(diffuseRgba, { raw: { width: w, height: h, channels: ch } })
    .webp({ quality: 88 })
    .toFile(path.join(outDir, diffuseName));

  if (slug === 'bg') {
    console.log('bg.webp', w, h);
    return;
  }

  // height (grayscale as rgb for simplicity matching original)
  const heightRgb = Buffer.alloc(n * 3);
  for (let i = 0; i < n; i++) {
    heightRgb[i * 3] = heightGray[i];
    heightRgb[i * 3 + 1] = heightGray[i];
    heightRgb[i * 3 + 2] = heightGray[i];
  }

  const prefix = baseName === 'cardBack' ? 'cardBack' : baseName;
  const heightFile = baseName === 'cardBack' ? 'cardBackHeight.webp' : `${prefix}-height.webp`;
  const normalFile = baseName === 'cardBack' ? 'cardBackNormal.webp' : `${prefix}-normal.webp`;
  const roughFile = baseName === 'cardBack' ? 'cardBackRoughness.webp' : `${prefix}-roughness.webp`;

  await sharp(heightRgb, { raw: { width: w, height: h, channels: 3 } })
    .webp({ quality: 85 })
    .toFile(path.join(CARDS, heightFile));

  await sharp(normalRgb, { raw: { width: w, height: h, channels: 3 } })
    .webp({ quality: 85 })
    .toFile(path.join(CARDS, normalFile));

  await sharp(roughGray, { raw: { width: w, height: h, channels: 3 } })
    .webp({ quality: 85 })
    .toFile(path.join(CARDS, roughFile));

  console.log('✓', prefix, w + 'x' + h);
}

async function main() {
  for (const [file, slug] of Object.entries(MAP)) {
    const src = path.join(IMG, file);
    if (!fs.existsSync(src)) {
      console.warn('missing', src);
      continue;
    }
    const isCard = slug !== 'bg';
    await processDiffuse(src, slug, isCard);
  }
  console.log('done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
