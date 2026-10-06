const path = require('path');
const fs = require("fs");
const webpack = require('webpack');
const NunjucksWebpackPlugin = require("nunjucks-webpack-plugin");
const CopyWebpackPlugin = require("copy-webpack-plugin");
const { heroGradient, heroImageUrl } = require('./src/js/heroBackground.js');

// Resized WebP variants written by optimizeImages.js (it runs before webpack in
// prod-hydrate / build). Keyed by the original's path under dist, e.g.
// "assets/images/student_imgs/<id>.png" -> { w, h, variants: [{ w, h, file }] }.
// Only the variants are shipped; the multi-megabyte originals stay in the build.
const MANIFEST_PATH = path.join(__dirname, 'image-manifest.json');
const IMAGE_MANIFEST = fs.existsSync(MANIFEST_PATH) ? JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) : null;
if (!IMAGE_MANIFEST) {
  console.warn('WARNING: image-manifest.json not found - run `npm run optimize-images`. '
    + 'Falling back to shipping the original images.');
}
const PLACEHOLDER_AVATAR = '/assets/images/missing_image.png';

function variantsFor(relPath) {
  if (!relPath || /^https?:\/\//i.test(relPath)) return null;
  return (IMAGE_MANIFEST && IMAGE_MANIFEST[String(relPath).replace(/^\//, '')]) || null;
}

// Hero <img> for a card or project page: src + srcset from the manifest; the raw
// hotlink for the few heroes that would not download (they lazy-load and vanish on
// error); null when there is no usable picture, so only the gradient tile shows.
function heroImage(project) {
  const url = heroImageUrl(project);
  if (!url) return null;
  const m = variantsFor(url);
  if (!m) {
    if (/^https?:\/\//i.test(url)) return { src: url, srcset: '', w: project.hero_w || 0, h: project.hero_h || 0 };
    if (IMAGE_MANIFEST) return null;                       // local file sharp could not decode
    return { src: '/' + url.replace(/^\//, ''), srcset: '', w: project.hero_w || 0, h: project.hero_h || 0 };
  }
  const vs = m.variants;
  // Nothing on the page renders a hero wider than ~420 CSS px (project page) or one
  // masonry column, so 960px covers 2x screens; the 1440 tier exists for og:image.
  const forImg = vs.filter(v => v.w <= 960);
  const pick = forImg.length ? forImg : vs;
  const mid = pick[Math.min(1, pick.length - 1)];
  return {
    src: '/' + mid.file,
    // a single pass-through variant (AVIF) has no measured width: plain src only
    srcset: pick.length > 1 ? pick.map(v => '/' + v.file + ' ' + v.w + 'w').join(', ') : '',
    w: m.w || project.hero_w || 0, h: m.h || project.hero_h || 0,
    large: '/' + vs[vs.length - 1].file,
    // JPEG rendition for link previews: LinkedIn/WhatsApp scrapers do not render WebP
    og: m.og ? '/' + m.og : '/' + vs[vs.length - 1].file,
  };
}

// 24px round avatar: the 96px variant with 192px for 2x screens, or the placeholder.
// Every branch returns the same shape - the templates read .large / .srcset_w too.
function avatarImage(relPath) {
  const m = variantsFor(relPath);
  if (!m) {
    const src = (!IMAGE_MANIFEST && relPath && !/missing_image/.test(relPath))
      ? '/' + String(relPath).replace(/^\//, '')
      : PLACEHOLDER_AVATAR;
    return { src: src, srcset: '', srcset_w: '', large: src };
  }
  const vs = m.variants;
  return {
    src: '/' + vs[0].file,
    // density form for the 24px circles; width form (+ sizes) for the 100px ones
    srcset: vs.length > 1 ? '/' + vs[0].file + ' 1x, /' + vs[1].file + ' 2x' : '',
    srcset_w: vs.map(v => '/' + v.file + ' ' + v.w + 'w').join(', '),
    large: '/' + vs[vs.length - 1].file,
  };
}

let data = JSON.parse(fs.readFileSync(path.join(__dirname, 'data.json'), 'utf8'));
// Airtable holds a few projects twice (same title + student, so the same derived
// project_id). That rendered duplicate cards in the gallery, and both cards opened
// the same page - whichever record webpack wrote last. Merge each set into one
// record, preferring populated values and unioning the list fields. related_proj
// stores indices into this array, so it has to be remapped as we collapse it.
function mergeDuplicateProjects(projects) {
  const indexById = {};
  const merged = [];
  const remap = [];
  projects.forEach((proj, oldIndex) => {
    const existing = indexById[proj.project_id];
    if (existing === undefined) {
      indexById[proj.project_id] = merged.length;
      remap[oldIndex] = merged.length;
      merged.push(Object.assign({}, proj));
      return;
    }
    remap[oldIndex] = existing;
    const target = merged[existing];
    Object.keys(proj).forEach(key => {
      if (key === 'related_proj') return;
      const incoming = proj[key];
      const current = target[key];
      if (Array.isArray(incoming) && Array.isArray(current)) {
        incoming.forEach(v => { if (current.indexOf(v) === -1) current.push(v); });
      } else if (current === null || current === undefined || current === '') {
        target[key] = incoming;
      }
    });
  });
  merged.forEach(proj => {
    const seen = {};
    proj.related_proj = (proj.related_proj || [])
      .map(i => remap[i])
      .filter(i => i !== undefined && merged[i] !== proj && !seen[i] && (seen[i] = true));
  });
  return merged;
}
data.projects = mergeDuplicateProjects(data.projects);
// The front page builds its cards client-side from data.json, so the copy shipped
// to dist has to be the deduped one too - otherwise the duplicate cards come back.
// Snapshot it here, before related_proj is expanded into objects further down
// (that turns the structure circular and unserialisable).
// The image fields the cards render from, attached before the snapshot so the
// client-side re-render (which reads data.json) builds exactly what the server did.
data.projects.forEach(function (item) {
  item.hero_img = heroImage(item);
  item.student_avatar = avatarImage(item.student_image);
  item.mentor_avatar = avatarImage(item.mentor_image);
});
const DEDUPED_DATA_JSON = JSON.stringify(data);

// ---------------------------------------------------------------- SEO
// The gallery builds its cards client-side, so the front page ships no links to
// the project pages at all - a crawler arriving without JS has nothing to follow.
// A sitemap is the reliable way to get them discovered, written at build time from
// the same list the pages are generated from so it can never drift.
const SITE = 'https://research.inspiritai.com';

function writeSeoFiles(projects) {
  const dir = path.resolve(__dirname, 'dist');
  fs.mkdirSync(dir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);

  const urls = [
    { loc: SITE + '/', priority: '1.0', freq: 'weekly' },
    { loc: SITE + '/published.html', priority: '0.8', freq: 'weekly' },
  ].concat(projects.map(function (p) {
    return {
      loc: SITE + '/projects/' + p.project_id + '.html',
      priority: '0.7',
      freq: 'monthly',
    };
  }));

  const body = urls.map(function (u) {
    return [
      '  <url>',
      '    <loc>' + u.loc + '</loc>',
      '    <lastmod>' + today + '</lastmod>',
      '    <changefreq>' + u.freq + '</changefreq>',
      '    <priority>' + u.priority + '</priority>',
      '  </url>',
    ].join('\n');
  }).join('\n');

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    body,
    '</urlset>',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'sitemap.xml'), xml, 'utf8');

  fs.writeFileSync(path.join(dir, 'robots.txt'), [
    'User-agent: *',
    'Allow: /',
    '',
    'Sitemap: ' + SITE + '/sitemap.xml',
    '',
  ].join('\n'), 'utf8');

  console.log('SEO: wrote sitemap.xml (' + urls.length + ' urls) and robots.txt');
}
// dist is never cleaned, so pages for projects that have since been removed from
// Airtable keep being served - 11 of them were live, returning stale content that
// is in no sitemap and linked from nowhere. Remove any project page whose id is no
// longer in the dataset, plus its bundle.
function pruneOrphanPages(projects) {
  const live = {};
  projects.forEach(function (p) { live[p.project_id] = 1; });
  const projDir = path.resolve(__dirname, 'dist', 'projects');
  const distDir = path.resolve(__dirname, 'dist');
  if (!fs.existsSync(projDir)) return;
  let removed = 0;
  fs.readdirSync(projDir).forEach(function (file) {
    const m = /^([0-9a-f]{40})\.html$/.exec(file);
    if (!m || live[m[1]]) return;
    fs.unlinkSync(path.join(projDir, file));
    const bundle = path.join(distDir, m[1] + '.js');
    if (fs.existsSync(bundle)) fs.unlinkSync(bundle);
    removed++;
  });
  if (removed) console.log('SEO: pruned ' + removed + ' orphaned project pages');
}

// dist is never cleaned, so the full-size originals (and variants of projects since
// removed) would keep being served from dist/assets/images - now with a month-long
// cache header. Keep only what the manifest says is current.
function pruneStaleImages() {
  if (!IMAGE_MANIFEST) return;
  const keep = {};
  Object.keys(IMAGE_MANIFEST).forEach(function (k) {
    IMAGE_MANIFEST[k].variants.forEach(function (v) { keep[v.file] = 1; });
    if (IMAGE_MANIFEST[k].og) keep[IMAGE_MANIFEST[k].og] = 1;
  });
  let removed = 0;
  ['project_graphics', 'mentor_imgs', 'student_imgs'].forEach(function (folder) {
    const dir = path.resolve(__dirname, 'dist', 'assets', 'images', folder);
    if (!fs.existsSync(dir)) return;
    fs.readdirSync(dir).forEach(function (f) {
      if (!keep['assets/images/' + folder + '/' + f]) { fs.unlinkSync(path.join(dir, f)); removed++; }
    });
  });
  if (removed) console.log('images: pruned ' + removed + ' stale files from dist/assets/images');
}

writeSeoFiles(data.projects);
pruneOrphanPages(data.projects);
pruneStaleImages();

let projects_raw = JSON.parse(JSON.stringify(data.projects))
let prodect_id_map = {}
projects_raw.forEach(proj => {
  const {project_id, ...new_obj} = proj
  prodect_id_map[project_id] = new_obj
})

data.projects.forEach((item, index) => {
  // Gradient only: the picture itself is now an <img> layered on top (see
  // heroImage above), not a CSS background that downloads at full size.
  data.projects[index].hero_bg = heroGradient(item);
  data.projects[index].hero_fallback = heroGradient(item);
  data.projects[index].hero_src = heroImageUrl(item);
  // Absolute URL for og:image - social scrapers will not resolve a root-relative
  // path. Left empty when the project has no picture so no broken card is shared.
  const heroSrc = item.hero_img ? (item.hero_img.og || item.hero_img.large || item.hero_img.src) : '';
  // Same clamp createProjectElement() applies, so the server-rendered cards have
  // the identical height and the JS re-render causes no layout shift. The ratio
  // comes from the picture actually shown (an override figure differs from the
  // dead download getData measured), falling back to getData's numbers for hotlinks.
  const img = item.hero_img;
  const ratio = (img && img.w && img.h) ? img.h / img.w
    : (item.hero_w && item.hero_h) ? item.hero_h / item.hero_w : 0.87;
  data.projects[index].card_ratio = Math.min(1.15, Math.max(0.65, ratio)).toFixed(3);
  data.projects[index].og_image = !heroSrc ? ''
    : (/^https?:\/\//i.test(heroSrc) ? heroSrc : SITE + heroSrc);
})
data.projects.forEach((item, index) => {
  data.projects[index].related_proj = item.related_proj.map(rel => { return data.projects[rel] });
})

let proj_ids = data.projects.map(item => {  
  return {
    from: "./src/html/project.html",
    to: `projects/${item.project_id}.html`,
    context: {ctx :item, isProject: true},
  };
});

let entry_points = { index: './src/js/index.js', published: './src/js/published.js', } 
data.projects.forEach(item => entry_points[item.project_id] = "./src/js/project.js");

 module.exports = {
   entry: entry_points,
   output: {
     filename: '[name].js',
     path: path.resolve(__dirname, 'dist'),
     publicPath: "/"
   },
   devServer: {
    static: [
      {
        directory: path.join(__dirname, 'dist'),
      },
      {
        directory: path.join(__dirname),
        publicPath: '/',
      }
    ],
    watchFiles: ['src/**/*', 'data.json']
   },
   module: {
     rules: [
       {
        test: /\.jsx?$/,   // anchored: unanchored this also matched .json and sent it to babel
        exclude: "/node_modules",
        use: {loader: 'babel-loader'}
       },
       {
        test: /\.s[ac]ss$/i,
        use: [
          // Creates `style` nodes from JS strings
          "style-loader",
          // Translates CSS into CommonJS
          {loader:"css-loader", 
            options: {
              url: false
            },
          },
          {
            loader: 'resolve-url-loader',
            // options: {...}
          },
          {
          // Compiles Sass to CSS
            loader: 'sass-loader',
            options: {
              sourceMap: true, // <-- !!IMPORTANT!!
            },
          }
        ],
      },
      {
        test: /\.(woff|woff2|eot|ttf|otf)$/,
        use: [
          {
            loader: 'file-loader',
            options: {
              name: 'assets/fonts/[name].[ext]',
            }
          }
        ]
      },
      // {
      //   test: /\.(jpe?g|png|gif|svg)$/i, 
      //   loader: 'file-loader',
      //   options: {
      //     name: 'assets/images/[name].[ext]'
      //   }
      // },
      // {test: /\.(png|jpg|svg)$/, loader: 'url-loader?limit=8192'},
     ],
   },
   node: {
    fs: "empty"
   },
   plugins: [
    new NunjucksWebpackPlugin({
      templates: [
        {
          from: "./src/html/index.html",
          to: "index.html",
          context: data,
        },
        {
          from: "./src/html/published.html",
          to: "published.html",
          context: data,
        },
        ...proj_ids
      ],
    }),
    // Removed data bundling - data is now loaded dynamically via dataService
    new CopyWebpackPlugin([
      // The hero/avatar originals stay out of dist; only the resized WebP variants
      // ship (see optimizeImages.js). Without a manifest everything is copied as before.
      {from:'src/assets/',to:'assets/',
       ignore: IMAGE_MANIFEST ? ['**/project_graphics/**', '**/mentor_imgs/**', '**/student_imgs/**'] : []},
      {from:'src/assets/images/project_graphics/*.{webp,avif}', to:'assets/images/project_graphics/', flatten: true},
      {from:'src/assets/images/project_graphics/*-og.jpg',      to:'assets/images/project_graphics/', flatten: true},
      {from:'src/assets/images/mentor_imgs/*.{webp,avif}',      to:'assets/images/mentor_imgs/',      flatten: true},
      {from:'src/assets/images/student_imgs/*.{webp,avif}',     to:'assets/images/student_imgs/',     flatten: true},
      {from:'data.json',to:'data.json',transform: () => DEDUPED_DATA_JSON}
    ]),
  ]
 };

