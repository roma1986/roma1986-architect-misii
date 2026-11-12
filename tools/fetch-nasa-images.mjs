// Завантажує фото NASA: для підсумку, глобальні карти для вибору майданчика
// і фото кожного елемента, який можна обрати (мініатюри й вікно «Детальніше»).
//
//   npm run images                 завантажити все, чого ще немає
//   npm run images -- --check      лише перевірити закріплені nasa_id, нічого не качати
//   npm run images -- --force      перезавантажити навіть те, що вже є
//
// Потрібен інтернет і Node 18+. Джерело: NASA Image and Video Library API (без ключа).
//
// Як скрипт обирає фото для елемента:
//   1. Якщо в data/photos.json (або media.json) є "nasa_id", пробує його.
//   2. Якщо ID не спрацював або його немає, шукає за полем "query" і бере перший підхожий результат.
//   3. У кінці друкує підсумок: що завантажено, що ні і чому.
// Знайдене автоматично позначається "auto": true: перегляньте такі фото в img/.
// Щоб замінити, знайдіть потрібне на https://images.nasa.gov, впишіть його nasa_id і запустіть з --force.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const mediaPath = path.join(root, 'data', 'media.json');
const photosPath = path.join(root, 'data', 'photos.json');
const force = process.argv.includes('--force');
const checkOnly = process.argv.includes('--check');
const API = process.env.NASA_API || 'https://images-api.nasa.gov';

const exists = (f) => fs.access(path.join(root, f)).then(() => true, () => false);

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function search(query) {
  const j = await getJson(`${API}/search?q=${encodeURIComponent(query)}&media_type=image`);
  return (j.collection?.items || []).slice(0, 12).map((it) => ({ id: it.data?.[0]?.nasa_id, data: it.data?.[0] || {} })).filter((x) => x.id);
}

/** Назва й автор для відомого nasa_id (потрібні для підпису в грі). */
async function metadata(id) {
  try {
    const j = await getJson(`${API}/search?nasa_id=${encodeURIComponent(id)}`);
    return j.collection?.items?.[0]?.data?.[0] || {};
  } catch { return {}; }
}

/** Посилання на картинку потрібного розміру. NASA дає ~orig, ~large, ~medium, ~small, ~thumb. */
async function assetUrl(id, prefer) {
  const j = await getJson(`${API}/asset/${encodeURIComponent(id)}`);
  const urls = (j.collection?.items || []).map((x) => x.href).filter((h) => /\.(jpe?g|png)$/i.test(h));
  for (const s of prefer) {
    const hit = s ? urls.find((u) => u.includes(`${s}.`)) : urls[0];
    if (hit) return hit;
  }
  return null;
}

/** Розмір JPEG/PNG без сторонніх бібліотек. */
export function imageSize(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

const credit = (d) => d.secondary_creator || d.photographer || (d.center ? `NASA/${d.center}` : 'NASA');
const toHttps = (u) => (/^http:\/\/[^/]*nasa\.gov/i.test(u) ? u.replace(/^http:/, 'https:') : u);

const report = { ok: [], existing: [], auto: [], failed: [] };

/** Спробувати завантажити одного кандидата. Повертає опис результату або кидає помилку з причиною. */
async function tryCandidate(item, c, prefer) {
  const url = await assetUrl(c.id, prefer);
  if (!url) throw new Error('у цього запису немає зображення JPEG/PNG');
  const res = await fetch(toHttps(url));
  if (!res.ok) throw new Error(`файл не завантажився (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const size = imageSize(buf);
  if (!size) throw new Error('файл не схожий на зображення');
  if (item.aspect && Math.abs(size.w / size.h - item.aspect) > 0.15) throw new Error(`пропорції ${size.w}×${size.h}, потрібні 2:1`);
  if (buf.length > (item.maxBytes || 6_000_000)) throw new Error(`завеликий файл (${Math.round(buf.length / 1024)} КБ)`);
  await fs.mkdir(path.dirname(path.join(root, item.file)), { recursive: true });
  await fs.writeFile(path.join(root, item.file), buf);
  return { size, kb: Math.round(buf.length / 1024) };
}

async function fetchItem(label, item) {
  if (!force && await exists(item.file)) { report.existing.push(label); console.log(`= ${label}: ${item.file} уже є`); return; }
  const prefer = item.prefer || ['~medium', '~large', '~small', '~orig', ''];
  const reasons = [];
  const attempts = [];
  if (item.nasa_id) attempts.push({ id: item.nasa_id, pinned: true });
  let searched = null;
  for (let k = 0; ; k++) {
    let c = attempts[k];
    if (!c) {
      if (searched || !item.query) break;
      try { searched = (await search(item.query)).filter((x) => x.id !== item.nasa_id); } catch (e) { reasons.push(`пошук «${item.query}»: ${e.message}`); break; }
      if (!searched.length) { reasons.push(`за запитом «${item.query}» нічого не знайдено`); break; }
      attempts.push(...searched.map((x) => ({ id: x.id, data: x.data, pinned: false })));
      c = attempts[k];
      if (!c) break;
    }
    try {
      const got = await tryCandidate(item, c, prefer);
      const meta = c.data && c.data.title ? c.data : await metadata(c.id);
      Object.assign(item, { nasa_id: c.id, title: meta.title || item.title, credit: meta.title ? credit(meta) : (item.credit || 'NASA'), url: `https://images.nasa.gov/details/${c.id}` });
      if (c.pinned) delete item.auto; else item.auto = true;
      const tag = c.pinned ? '+' : '~';
      console.log(`${tag} ${label}: ${item.file} ← ${c.id} (${got.size.w}×${got.size.h}, ${got.kb} КБ)${c.pinned ? '' : '  знайдено пошуком — перегляньте'}`);
      (c.pinned ? report.ok : report.auto).push(label);
      return;
    } catch (e) {
      reasons.push(`${c.id}: ${e.message}`);
      if (reasons.length >= 6) break;
    }
  }
  report.failed.push(label);
  console.log(`! ${label}: фото не знайдено. ${reasons.slice(0, 3).join('; ')}. Знайдіть вручну: https://images.nasa.gov/search?q=${encodeURIComponent(item.query || label)}`);
}

async function checkItem(label, item) {
  if (!item.nasa_id) { console.log(`- ${label}: nasa_id немає, буде пошук за «${item.query || '—'}»`); return; }
  try { await assetUrl(item.nasa_id, ['']); console.log(`ok ${label}: ${item.nasa_id}`); report.ok.push(label); }
  catch (e) { console.log(`ПОМИЛКА ${label}: ${item.nasa_id} — ${e.message}`); report.failed.push(label); }
}

async function main() {
  const media = JSON.parse(await fs.readFile(mediaPath, 'utf8'));
  const photos = JSON.parse(await fs.readFile(photosPath, 'utf8'));
  // Усі записи редагуються на місці, тому джерело правди — самі файли JSON
  const jobs = [
    ...media.items.map((it) => ({ label: `підсумок ${it.target}/${it.platform_type}`, item: it, extra: {} })),
    ...(media.maps || []).map((it) => ({ label: `карта ${it.target}`, item: it, extra: { prefer: ['~large', '~orig', '~medium', ''] } })),
    ...Object.entries(photos).filter(([id, it]) => !id.startsWith('_') && !it.skip)
      .map(([id, it]) => ({ label: id, item: it, extra: { maxBytes: 2_500_000 }, defaultFile: `img/items/${id}.jpg` })),
  ];
  for (const { label, item, extra, defaultFile } of jobs) {
    if (defaultFile) item.file = item.file || defaultFile;
    if (checkOnly) { await checkItem(label, item); continue; }
    Object.assign(item, extra);               // службові поля лише на час завантаження
    try { await fetchItem(label, item); } finally { for (const k of Object.keys(extra)) delete item[k]; }
    await fs.writeFile(photosPath, JSON.stringify(photos, null, 2) + '\n');
    await fs.writeFile(mediaPath, JSON.stringify(media, null, 2) + '\n');
  }
  if (!checkOnly) {
    // "file" лишається лише там, де файл справді є: гра показує фото тільки за цим полем
    for (const [id, item] of Object.entries(photos)) {
      if (!id.startsWith('_') && item.file && !(await exists(item.file))) delete item.file;
    }
    await fs.writeFile(photosPath, JSON.stringify(photos, null, 2) + '\n');
  }
  const total = jobs.length;
  console.log('\n──────── Підсумок ────────');
  if (checkOnly) {
    console.log(`Перевірено ${total}. ID працюють: ${report.ok.length}. Не працюють: ${report.failed.length}${report.failed.length ? ` (${report.failed.join(', ')})` : ''}.`);
    console.log('Не працюючі ID можна не виправляти: під час npm run images скрипт знайде фото пошуком за запитом.');
    return;
  }
  console.log(`Завантажено за закріпленим ID: ${report.ok.length}`);
  console.log(`Знайдено пошуком (перегляньте!): ${report.auto.length}${report.auto.length ? ` — ${report.auto.join(', ')}` : ''}`);
  console.log(`Вже були: ${report.existing.length}`);
  console.log(`Не вдалося: ${report.failed.length}${report.failed.length ? ` — ${report.failed.join(', ')}` : ''}`);
  if (report.failed.length === total) console.log('\nУсе не вдалося: перевірте інтернет (мають відкриватися images-api.nasa.gov та images-assets.nasa.gov), VPN і мережевий екран.');
  console.log('\nДалі: перегляньте папку img/ і завантажте на GitHub папку img/ та файли data/photos.json і data/media.json.');
  console.log('Щоб замінити фото: знайдіть потрібне на https://images.nasa.gov, впишіть його nasa_id у data/photos.json і запустіть: npm run images -- --force');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`Помилка: ${e.message}`); process.exit(1); });
}
