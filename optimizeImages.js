/**
 * Build-time image optimisation for the gallery.
 *
 * getData.js saves every hero, mentor and student picture exactly as the source
 * served it - phone photos of 6000px and 10 MB were being shipped to paint a 24px
 * avatar, and the front page pulled ~250 MB per visit. This step walks the three
 * image folders and writes small WebP variants next to each original:
 *
 *   project_graphics/<id>.png  ->  <id>-480.webp  <id>-960.webp  <id>-1440.webp
 *   student_imgs/<id>.png      ->  <id>-96.webp   <id>-192.webp   (square, face-cropped)
 *   mentor_imgs/<id>.png       ->  same as students
 *
 * and records them in image-manifest.json, which webpack.config.js reads to emit
 * <img srcset> markup. Only the variants are copied to dist; the originals never
 * leave the build. A file sharp cannot decode (an HTML error page saved as .png,
 * an HEIC no browser renders) gets no entry, and the page falls back exactly as
 * it does for a missing picture: gradient tile for a hero, placeholder avatar.
 *
 *   node optimizeImages.js            # incremental: skips variants newer than the source
 *   node optimizeImages.js --force    # regenerate everything
 */
'use strict';
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, 'src', 'assets', 'images');
const MANIFEST = path.join(__dirname, 'image-manifest.json');
const FORCE = process.argv.includes('--force');

// Cards are one third of a ~1320px container (~440px) at 1x, double at 2x; the
// expanded card and the project page hero top out around 900px at 2x. Avatars
// render at 24px, so 96 covers 4x displays and 192 is the project header's margin.
const FOLDERS = {
  project_graphics: { widths: [480, 960, 1440], quality: 78, square: false, og: 1200 },
  student_imgs:     { widths: [96, 192],         quality: 80, square: true },
  mentor_imgs:      { widths: [96, 192],         quality: 80, square: true },
};
const VARIANT_RE = /-(\d+|orig|og)\.(webp|avif|jpg)$/;
const CONCURRENCY = 4;

function isAvif(file) {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(12);
  fs.readSync(fd, buf, 0, 12, 0);
  fs.closeSync(fd);
  const brand = buf.slice(8, 12).toString('latin1');
  return buf.slice(4, 8).toString('latin1') === 'ftyp' && (brand === 'avif' || brand === 'avis');
}

function listSources(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => !f.startsWith('.') && !VARIANT_RE.test(f));
}

async function processOne(folder, file, opts, manifest, stats) {
  const abs = path.join(ROOT, folder, file);
  const base = file.replace(/\.[^.]+$/, '');
  const key = 'assets/images/' + folder + '/' + file;
  const srcSize = fs.statSync(abs).size;
  stats.srcBytes += srcSize;

  // AVIF is something every current browser renders but this sharp build may not
  // decode (metadata() can even succeed and the decode then fail). Ship the file
  // as-is rather than losing the picture.
  const passThroughAvif = (w, h) => {
    const outFile = base + '-orig.avif';
    fs.copyFileSync(abs, path.join(ROOT, folder, outFile));
    stats.outBytes += srcSize;
    manifest[key] = { w: w, h: h, variants: [{ w: w, h: h, file: 'assets/images/' + folder + '/' + outFile }] };
    stats.ok++;
  };

  let meta;
  try {
    meta = await sharp(abs).rotate().metadata();   // rotate(): honour EXIF orientation
    if (!meta.width || !meta.height) throw new Error('no dimensions');
  } catch (err) {
    if (isAvif(abs)) return passThroughAvif(0, 0);
    stats.bad.push(key + ' (' + (err.message || err).toString().split('\n')[0].slice(0, 60) + ')');
    return;
  }
  // After rotate() the reported width/height are pre-rotation; swap for 90/270.
  const rotated = meta.orientation >= 5;
  const srcW = rotated ? meta.height : meta.width;
  const srcH = rotated ? meta.width : meta.height;

  // Target widths that fit inside the source, plus the source's own width as the
  // top tier when it sits between two targets (a 915px hero would otherwise ship
  // only a 480px copy), never upscaling and never beyond the largest target.
  let widths = opts.widths.filter(w => w <= srcW);
  const maxTarget = opts.widths[opts.widths.length - 1];
  if (!widths.length) widths = [Math.min(srcW, opts.widths[0])];
  else if (srcW > widths[widths.length - 1] && srcW < maxTarget) widths.push(srcW);

  const variants = [];
  let og = null;
  try {
    const source = sharp(abs).rotate();          // decoded once, cloned per output
    const srcMtime = fs.statSync(abs).mtimeMs;
    const isFresh = f => !FORCE && fs.existsSync(f) && fs.statSync(f).mtimeMs >= srcMtime;
    for (const w of widths) {
      const outFile = base + '-' + w + '.webp';
      const outAbs = path.join(ROOT, folder, outFile);
      let info;
      if (isFresh(outAbs)) {
        info = await sharp(outAbs).metadata();
      } else {
        let img = source.clone();
        img = opts.square
          ? img.resize(w, w, { fit: 'cover', position: 'attention' })
          : img.resize({ width: w, withoutEnlargement: true });
        info = await img.webp({ quality: opts.quality, effort: 4 }).toFile(outAbs);
        stats.written++;
      }
      stats.outBytes += fs.statSync(outAbs).size;
      variants.push({ w: info.width, h: info.height, file: 'assets/images/' + folder + '/' + outFile });
    }
    // One JPEG per hero for og:image - link-preview scrapers (LinkedIn, WhatsApp)
    // do not render WebP. Never requested by page visitors.
    if (opts.og) {
      const ogFile = base + '-og.jpg';
      const ogAbs = path.join(ROOT, folder, ogFile);
      if (!isFresh(ogAbs)) {
        await source.clone().resize({ width: opts.og, withoutEnlargement: true })
          .flatten({ background: '#ffffff' }).jpeg({ quality: 80, mozjpeg: true }).toFile(ogAbs);
        stats.written++;
      }
      stats.outBytes += fs.statSync(ogAbs).size;
      og = 'assets/images/' + folder + '/' + ogFile;
    }
  } catch (err) {
    // Decode failures after a good metadata(): HEIC with an HEVC bitstream, a
    // truncated download, an AVIF this build cannot read. Leave no half-written files.
    variants.forEach(v => { try { fs.unlinkSync(path.join(__dirname, 'src', v.file)); } catch (e) { /* gone */ } });
    if (isAvif(abs)) return passThroughAvif(srcW, srcH);
    stats.bad.push(key + ' (' + (err.message || err).toString().split('\n').pop().slice(0, 70) + ')');
    return;
  }
  manifest[key] = { w: srcW, h: srcH, variants, og };
  stats.ok++;
}

async function run() {
  const manifest = {};
  const stats = { ok: 0, written: 0, bad: [], srcBytes: 0, outBytes: 0 };
  const jobs = [];
  for (const folder of Object.keys(FOLDERS)) {
    for (const file of listSources(path.join(ROOT, folder))) jobs.push([folder, file, FOLDERS[folder]]);
  }
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const [folder, file, opts] = jobs[next++];
      await processOne(folder, file, opts, manifest, stats);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // Variants whose source is gone (project removed from Airtable) just clutter the
  // folder and would be copied to dist; drop them.
  let orphans = 0;
  for (const folder of Object.keys(FOLDERS)) {
    const dir = path.join(ROOT, folder);
    if (!fs.existsSync(dir)) continue;
    const live = new Set(Object.values(manifest).flatMap(m =>
      m.variants.map(v => path.basename(v.file)).concat(m.og ? [path.basename(m.og)] : [])));
    fs.readdirSync(dir).forEach(f => {
      if (VARIANT_RE.test(f) && !live.has(f)) { fs.unlinkSync(path.join(dir, f)); orphans++; }
    });
  }

  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1));
  const mb = n => (n / 1e6).toFixed(1) + ' MB';
  console.log('optimizeImages: ' + stats.ok + ' images -> ' + Object.values(manifest).reduce((n, m) => n + m.variants.length, 0)
    + ' variants (' + stats.written + ' newly written, ' + orphans + ' orphan variants removed)');
  console.log('optimizeImages: originals ' + mb(stats.srcBytes) + ' -> variants ' + mb(stats.outBytes));
  if (stats.bad.length) {
    console.log('optimizeImages: ' + stats.bad.length + ' files could not be decoded and will use the fallback:');
    stats.bad.slice(0, 12).forEach(b => console.log('   ' + b));
    if (stats.bad.length > 12) console.log('   ... and ' + (stats.bad.length - 12) + ' more');
  }
}

run().catch(err => { console.error('optimizeImages failed:', err); process.exit(1); });
