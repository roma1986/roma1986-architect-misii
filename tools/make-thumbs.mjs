// Готує зображення до публікації: мініатюри для карток і стиснення великих файлів.
//   npm run thumbs
// Потрібна бібліотека sharp. Якщо її немає, скрипт підкаже команду для встановлення (один раз, у проєкт вона не додається).
//
// Що робить (безпечно запускати повторно):
//   1. Для кожного img/items/<id>.jpg створює img/items/thumb/<id>.jpg (480 px завширшки): так картки вантажать
//      по 20–40 КБ замість 300–600 КБ. Гра бере мініатюру, а якщо її немає, — повне фото.
//   2. Стискає всі великі фото в img/ до 1280 px за довшою стороною (якість 82), якщо це зменшує файл.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let sharp;
try { sharp = (await import('sharp')).default; } catch {
  console.error('Потрібна бібліотека sharp. Виконайте один раз:  npm install --no-save sharp\nПотім повторіть:  npm run thumbs');
  process.exit(1);
}
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const img = path.join(root, 'img');
const THUMB_W = 480;
const MAX_SIDE = 1280;
const kb = (n) => `${Math.round(n / 1024)} КБ`;

const listJpg = async (dir) => (await fs.readdir(dir, { withFileTypes: true }).catch(() => []))
  .filter((e) => e.isFile() && /\.jpe?g$/i.test(e.name)).map((e) => path.join(dir, e.name));

let before = 0; let after = 0; let resized = 0; let thumbs = 0;
for (const file of [...await listJpg(img), ...await listJpg(path.join(img, 'items'))]) {
  const src = await fs.readFile(file);
  before += src.length;
  const meta = await sharp(src).metadata();
  // 1. Стиснення великих фото на місці (EXIF-поворот застосовується, метадані прибираються)
  let out = src;
  if (Math.max(meta.width, meta.height) > MAX_SIDE) {
    const small = await sharp(src).rotate().resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
    if (small.length < src.length) { await fs.writeFile(file, small); out = small; resized++; }
  }
  after += out.length;
  // 2. Мініатюра лише для фото елементів
  if (path.dirname(file) === path.join(img, 'items')) {
    const tdir = path.join(img, 'items', 'thumb');
    await fs.mkdir(tdir, { recursive: true });
    const t = await sharp(out).rotate().resize({ width: THUMB_W, withoutEnlargement: true }).jpeg({ quality: 78, mozjpeg: true, progressive: true }).toBuffer();
    await fs.writeFile(path.join(tdir, path.basename(file)), t);
    thumbs++;
  }
}
console.log(`Стиснуто великих фото: ${resized}. Створено мініатюр: ${thumbs}.`);
console.log(`Розмір повних фото: ${kb(before)} → ${kb(after)}.`);
let tsize = 0; for (const f of await listJpg(path.join(img, 'items', 'thumb'))) tsize += (await fs.stat(f)).size;
console.log(`Мініатюри разом: ${kb(tsize)}. Завантажте на GitHub усю папку img/ (разом з img/items/thumb/).`);
