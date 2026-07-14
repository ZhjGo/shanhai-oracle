/**
 * 从 diffuse 重烘焙 PBR
 *
 * 目标：细腻「烫金 / 边框 / 装饰线」浮雕；
 *       人物脸、皮肤、大面积色块保持平滑，避免糊脸、坑洼感。
 *
 * 用法：node scripts/refine-pbr.mjs
 */
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CARDS = path.join(__dirname, '../public/assets/cards');

function gaussianBlur1D(src, w, h, radius) {
  if (radius < 1) return Float32Array.from(src);
  const sigma = Math.max(0.6, radius * 0.45);
  const size = radius * 2 + 1;
  const kernel = new Float32Array(size);
  let sum = 0;
  for (let i = 0; i < size; i++) {
    const x = i - radius;
    kernel[i] = Math.exp(-(x * x) / (2 * sigma * sigma));
    sum += kernel[i];
  }
  for (let i = 0; i < size; i++) kernel[i] /= sum;

  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let k = -radius; k <= radius; k++) {
        const xx = Math.min(w - 1, Math.max(0, x + k));
        v += src[y * w + xx] * kernel[k + radius];
      }
      tmp[y * w + x] = v;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let k = -radius; k <= radius; k++) {
        const yy = Math.min(h - 1, Math.max(0, y + k));
        v += tmp[yy * w + x] * kernel[k + radius];
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

function scharrNormal(height, w, h, strength) {
  const out = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const xm = Math.max(0, x - 1);
      const xp = Math.min(w - 1, x + 1);
      const ym = Math.max(0, y - 1);
      const yp = Math.min(h - 1, y + 1);
      const tl = height[ym * w + xm];
      const t = height[ym * w + x];
      const tr = height[ym * w + xp];
      const l = height[y * w + xm];
      const r = height[y * w + xp];
      const bl = height[yp * w + xm];
      const b = height[yp * w + x];
      const br = height[yp * w + xp];
      const dx = (3 * tl + 10 * l + 3 * bl) - (3 * tr + 10 * r + 3 * br);
      const dy = (3 * tl + 10 * t + 3 * tr) - (3 * bl + 10 * b + 3 * br);
      let nx = -dx * strength;
      let ny = -dy * strength;
      let nz = 1.0;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      nz /= len;
      const o = (y * w + x) * 3;
      out[o] = Math.round((nx * 0.5 + 0.5) * 255);
      out[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      out[o + 2] = Math.round((nz * 0.5 + 0.5) * 255);
    }
  }
  return out;
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** 皮肤 / 人物肤色区域：应尽量压平 */
function skinScore(r, g, b) {
  // 常见肤色：R 偏高、G 中等、B 偏低，饱和度不过高
  if (r < 0.35 || r < g - 0.02) return 0;
  if (r < b) return 0;
  const maxc = Math.max(r, g, b);
  const minc = Math.min(r, g, b);
  const sat = maxc < 1e-5 ? 0 : (maxc - minc) / maxc;
  if (sat > 0.55) return 0; // 太艳不是皮肤
  // 黄/粉肤
  const rg = r - g;
  const rb = r - b;
  if (rb < 0.04 || rg < -0.05) return 0;
  if (g < 0.18 || g > 0.85) return 0;
  // 亮度落在皮肤区间
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (L < 0.22 || L > 0.92) return 0;
  return clamp01(0.35 + rb * 1.2 + (0.45 - Math.abs(sat - 0.25)) * 0.8);
}

/** 烫金 / 描金 / 亮金属线 */
function goldScore(r, g, b) {
  const maxc = Math.max(r, g, b);
  const minc = Math.min(r, g, b);
  const sat = maxc < 1e-5 ? 0 : (maxc - minc) / maxc;
  // 金：R、G 高，B 明显低
  const metal =
    r > 0.42 &&
    g > 0.32 &&
    r > b + 0.08 &&
    g > b + 0.04 &&
    sat > 0.14 &&
    sat < 0.85;
  if (!metal) return 0;
  return clamp01((r - b) * 1.8 * sat * 1.4);
}

/** 冷亮装饰（银、月、蓝描边） */
function coolMetalScore(r, g, b) {
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const maxc = Math.max(r, g, b);
  const minc = Math.min(r, g, b);
  const sat = maxc < 1e-5 ? 0 : (maxc - minc) / maxc;
  // 亮且偏冷、或高亮细线
  if (L > 0.72 && sat < 0.25) return clamp01((L - 0.72) * 3);
  if (b > r + 0.05 && b > g && L > 0.4 && sat > 0.12) return clamp01(sat * 0.8);
  return 0;
}

async function refineSlug(slug) {
  const diffusePath = path.join(CARDS, slug + '.webp');
  if (!fs.existsSync(diffusePath)) return false;

  const { data, info } = await sharp(diffusePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width;
  const h = info.height;
  const ch = info.channels;
  const n = w * h;

  const lum = new Float32Array(n);
  const gold = new Float32Array(n);
  const cool = new Float32Array(n);
  const skin = new Float32Array(n);
  const alpha = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const o = i * ch;
    const r = data[o] / 255;
    const g = data[o + 1] / 255;
    const b = data[o + 2] / 255;
    const a = ch === 4 ? data[o + 3] / 255 : 1;
    alpha[i] = a;
    if (a < 0.04) continue;
    lum[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    gold[i] = goldScore(r, g, b);
    cool[i] = coolMetalScore(r, g, b);
    skin[i] = skinScore(r, g, b);
  }

  // 平滑皮肤 mask，避免脸边缘硬切
  const skinSoft = gaussianBlur1D(skin, w, h, 6);

  // 装饰 mask：金 + 冷金属 + 强对比线（且非皮肤）
  const mid = gaussianBlur1D(lum, w, h, 2);
  const edge = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const e = Math.abs(lum[i] - mid[i]);
    // 只保留较强的线，忽略皮肤微纹理
    const line = e > 0.035 ? clamp01((e - 0.035) * 8) : 0;
    const decor = Math.max(gold[i], cool[i] * 0.85, line * (1 - skinSoft[i] * 0.95));
    edge[i] = decor;
  }
  const decor = gaussianBlur1D(edge, w, h, 1);

  // 高度：默认平坦 0.5；只在装饰上抬起；皮肤强制压回平面
  const height = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (alpha[i] < 0.04) {
      height[i] = 0.5;
      continue;
    }
    let ht = 0.5;
    // 描金 / 装饰线抬升（克制，避免夸张）
    ht += decor[i] * 0.32;
    ht += gold[i] * 0.12;

    // 边框
    const x = i % w;
    const y = (i / w) | 0;
    const e = Math.min(x, y, w - 1 - x, h - 1 - y);
    if (e < 18) ht += (1 - e / 18) * 0.1;

    // 皮肤区域：压回平坦，只保留极弱的装饰（如金饰）
    const s = skinSoft[i];
    if (s > 0.08) {
      const flat = 0.5 + gold[i] * 0.08; // 脸上金饰可微微鼓
      ht = ht * (1 - s * 0.92) + flat * (s * 0.92);
    }

    height[i] = clamp01(ht);
  }

  // 轻微平滑整体，去掉噪点坑洼
  const hSmooth = gaussianBlur1D(height, w, h, 1);
  for (let i = 0; i < n; i++) {
    // 装饰处保留更多锐度，皮肤处更糊
    const s = skinSoft[i];
    height[i] = height[i] * (0.35 + decor[i] * 0.4) * (1 - s * 0.5)
      + hSmooth[i] * (0.65 - decor[i] * 0.35 + s * 0.5);
    height[i] = clamp01(height[i]);
  }

  // 法线强度：整体温和；装饰略强
  // 对皮肤像素直接输出平坦法线
  const nMap = scharrNormal(height, w, h, 2.1);
  const normalRgb = Buffer.alloc(n * 3);
  for (let i = 0; i < n; i++) {
    const o = i * 3;
    const s = skinSoft[i];
    if (s > 0.35 && gold[i] < 0.15) {
      // 平坦：指向镜头
      normalRgb[o] = 128;
      normalRgb[o + 1] = 128;
      normalRgb[o + 2] = 255;
    } else if (s > 0.12) {
      // 混合：减弱脸部法线
      let nx = nMap[o] / 255 * 2 - 1;
      let ny = nMap[o + 1] / 255 * 2 - 1;
      let nz = nMap[o + 2] / 255 * 2 - 1;
      const k = 1 - s * 0.85;
      nx *= k;
      ny *= k;
      nz = Math.sqrt(Math.max(0.05, 1 - nx * nx - ny * ny));
      normalRgb[o] = Math.round((nx * 0.5 + 0.5) * 255);
      normalRgb[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      normalRgb[o + 2] = Math.round((nz * 0.5 + 0.5) * 255);
    } else {
      normalRgb[o] = nMap[o];
      normalRgb[o + 1] = nMap[o + 1];
      normalRgb[o + 2] = nMap[o + 2];
    }
  }

  // 粗糙度：皮肤哑光均匀；金线亮；其余纸面
  const roughRgb = Buffer.alloc(n * 3);
  for (let i = 0; i < n; i++) {
    let rough = 0.7;
    rough -= gold[i] * 0.48;
    rough -= cool[i] * 0.2;
    rough -= decor[i] * 0.08;
    // 皮肤统一哑光，避免脸部高光斑驳
    if (skinSoft[i] > 0.2) {
      rough = 0.62 + (1 - skinSoft[i]) * 0.05 - gold[i] * 0.25;
    }
    rough = clamp01(rough);
    const rv = Math.round(rough * 255);
    roughRgb[i * 3] = roughRgb[i * 3 + 1] = roughRgb[i * 3 + 2] = rv;
  }

  const heightRgb = Buffer.alloc(n * 3);
  for (let i = 0; i < n; i++) {
    const v = Math.round(height[i] * 255);
    heightRgb[i * 3] = heightRgb[i * 3 + 1] = heightRgb[i * 3 + 2] = v;
  }

  const isBack = slug === 'cardBack';
  const heightFile = isBack ? 'cardBackHeight.webp' : `${slug}-height.webp`;
  const normalFile = isBack ? 'cardBackNormal.webp' : `${slug}-normal.webp`;
  const roughFile = isBack ? 'cardBackRoughness.webp' : `${slug}-roughness.webp`;

  await Promise.all([
    sharp(heightRgb, { raw: { width: w, height: h, channels: 3 } })
      .webp({ quality: 90 })
      .toFile(path.join(CARDS, heightFile)),
    sharp(normalRgb, { raw: { width: w, height: h, channels: 3 } })
      .webp({ quality: 90 })
      .toFile(path.join(CARDS, normalFile)),
    sharp(roughRgb, { raw: { width: w, height: h, channels: 3 } })
      .webp({ quality: 90 })
      .toFile(path.join(CARDS, roughFile)),
  ]);

  console.log('✓', slug);
  return true;
}

async function main() {
  const files = fs.readdirSync(CARDS);
  const slugs = new Set();
  for (const f of files) {
    if (!f.endsWith('.webp')) continue;
    if (/-normal|-roughness|-height|Normal|Roughness|Height/.test(f)) continue;
    slugs.add(f.replace(/\.webp$/, ''));
  }
  console.log('refining', slugs.size, 'cards (face-safe)…');
  for (const slug of [...slugs].sort()) {
    await refineSlug(slug);
  }
  console.log('done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
