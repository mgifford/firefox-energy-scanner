/**
 * A fixture website with known behaviours, for end-to-end tests of the
 * component graph, attribution, tracing and experiments. Every page shares a
 * header, navigation and footer, a site stylesheet and a site script. The
 * twelve behaviours the tests rely on:
 *
 *  1. /light           a static, lightweight page
 *  2. /big-list        a large static DOM (2,000 list items)
 *  3. /compute         a small page with expensive script (a 300 ms loop)
 *  4. /                a continuously animated component (CSS, never stops)
 *  5. /table           an expensive event-driven component (sorting re-renders 1,500 rows)
 *  6. /                an oversized image (2400×1600 shown at 240×160)
 *  7. /embed           a third-party iframe (from thirdparty.test)
 *  8. all pages        a navigation component shared across pages
 *  9. /articles/d      a unique expensive component on one page (a chart redrawn every frame)
 * 10. /articles/*      nested components (cards in a card list) sharing one script
 * 11. /tiny-work       a timer doing negligible work: removing it changes little
 * 12. /spinner         a CSS-only spinner: pausing it saves work without changing transfer
 *
 * And /assets, for Lighthouse's resource findings: a render-blocking
 * stylesheet whose rules are mostly unused, and a large, mostly unused script.
 *
 * Key pages, which a crawl finds from the home page: a search form (results
 * at /search?q=, not in the sitemap, as on most sites), contact and
 * accessibility statement links in the footer, and an HTML "not found" page.
 *
 * The sitemap also lists two files, which a scan must skip rather than
 * measure: a PDF at an address with no extension, as Drupal file aliases are
 * (/files/document/annual-reportpdf), and a CSV with one (/files/data.csv).
 *
 * Synthetic content only. Usage:
 *   import { startFixtureSite } from './tests/fixtures/site/server.mjs';
 *   const site = await startFixtureSite({ port: 8082 });  // site.url, site.close()
 * Host names: www.site.test (the site) and thirdparty.test (the embed); CI maps both to 127.0.0.1.
 */
import http from 'node:http';

const nav = `<nav aria-label="Main" data-component-id="site-nav"><ul>
  ${['/', '/light', '/big-list', '/compute', '/table', '/embed', '/articles/a', '/spinner'].map((p) => `<li><a href="${p}">${p === '/' ? 'Home' : p.slice(1)}</a></li>`).join('')}
</ul></nav>`;

const page = (title, body, { head = '', bodyEnd = '' } = {}) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<link rel="stylesheet" href="/css/site.css"><script src="/js/site.js" defer></script>${head}</head>
<body><header class="site-header" data-component-id="site-header"><a href="/" class="brand">Fixture</a>${nav}
<form role="search" action="/search" method="get"><label>Search <input type="search" name="q"></label> <button>Search</button></form></header>
<main id="main"><h1>${title}</h1>${body}</main>
<footer data-component-id="site-footer"><p>Fixture site footer. Synthetic content.</p>
<p><a href="/contact">Contact us</a> · <a href="/accessibility">Accessibility statement</a></p></footer>${bodyEnd}</body></html>`;

const cards = (n, prefix) =>
  `<section aria-label="Related" data-component-id="card-list"><script src="/js/cards.js" defer></script>${Array.from({ length: n }, (_, i) =>
    `<article data-component-id="card"><h2>${prefix} ${i + 1}</h2><img src="/img/thumb-${i}.svg" width="120" height="80" alt="Thumbnail ${i + 1}"><p>Summary text.</p></article>`,
  ).join('')}</section>`;

const article = (id, extra = '') =>
  page(`Article ${id.toUpperCase()}`, `<article data-component-id="article-body"><p>${'Article text. '.repeat(40)}</p></article>${extra}${cards(4, `Card ${id}`)}`);

const PAGES = {
  '/': page(
    'Home',
    `<div class="hero" data-component-id="hero"><div class="pulse" aria-hidden="true"></div>
       <img src="/img/huge.svg" width="240" height="160" alt="A large decorative picture"></div>${cards(3, 'Home card')}`,
    { head: '<style>.pulse{width:40px;height:40px;background:#036;animation:pulse 1.2s ease-in-out infinite alternate}@keyframes pulse{from{transform:scale(1)}to{transform:scale(1.4)}}</style>' },
  ),
  '/light': page('Light', '<p>Plain text and nothing else.</p>'),
  '/big-list': page('Big list', `<section aria-label="Every item" data-component-id="long-list"><ul>${Array.from({ length: 2000 }, (_, i) => `<li>Item ${i + 1}</li>`).join('')}</ul></section>`),
  '/compute': page('Compute', '<p>This page computes on load.</p>', { head: '<script src="/js/compute.js"></script>' }),
  '/table': page(
    'Table',
    `<section aria-label="Data" data-component-id="data-table"><button type="button" id="sort">Sort by value</button>
     <table><caption>Values</caption><thead><tr><th scope="col">Name</th><th scope="col">Value</th></tr></thead><tbody id="rows"></tbody></table></section>`,
    { bodyEnd: '<script src="/js/table.js"></script>' },
  ),
  '/embed': page('Embed', `<section aria-label="Embedded widget" data-component-id="widget-embed"><iframe title="Third-party widget" src="http://thirdparty.test:PORT/widget" width="300" height="150"></iframe></section>`),
  '/articles/a': article('a'),
  '/articles/b': article('b'),
  '/articles/c': article('c'),
  '/articles/d': article('d', `<figure data-component-id="live-chart"><canvas id="chart" width="600" height="200" aria-label="A chart redrawn every frame"></canvas><figcaption>Live chart</figcaption></figure><script src="/js/chart.js"></script>`),
  '/tiny-work': page('Tiny work', '<p id="clock">0</p>', { bodyEnd: '<script>let n=0;setInterval(()=>{n++;},2000);</script>' }),
  '/assets': page('Assets', '<p class="used">Only one rule of the big stylesheet applies here.</p>', {
    head: '<link rel="stylesheet" href="/css/big.css"><script src="/js/big.js"></script>',
  }),
  '/contact': page('Contact us', '<p>Write to the fixture team.</p><form action="/contact" method="post"><label>Your message <textarea name="m"></textarea></label><button>Send</button></form>'),
  '/accessibility': page('Accessibility statement', `<p>${'This synthetic site aims to meet WCAG 2.2 AA. '.repeat(6)}</p>`),
  '/spinner': page('Spinner', '<div class="spinner" role="status" aria-label="Loading" data-component-id="spinner"></div>', {
    head: '<style>.spinner{width:48px;height:48px;border:6px solid #ccc;border-top-color:#036;border-radius:50%;animation:spin 0.8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}</style>',
  }),
};

/** Listed in the sitemap, but not pages. */
const FILES = {
  '/files/document/annual-reportpdf': ['application/pdf', '%PDF-1.4\n% synthetic fixture file, not a real PDF\n%%EOF\n'],
  '/files/data.csv': ['text/csv; charset=utf-8', 'name,value\na,1\n'],
};

const SCRIPTS = {
  '/js/site.js': 'document.documentElement.classList.add("js");',
  '/js/cards.js': 'window.cardsReady = true;',
  '/js/compute.js': 'const t0 = performance.now(); let x = 0; while (performance.now() - t0 < 300) { x += Math.sqrt(Math.random()); } window.computed = x;',
  '/js/table.js': `const rows = Array.from({ length: 1500 }, (_, i) => ({ name: 'Row ' + i, value: (i * 7919) % 1000 }));
function render(list) { document.getElementById('rows').innerHTML = list.map((r) => '<tr><td>' + r.name + '</td><td>' + r.value + '</td></tr>').join(''); }
render(rows);
document.getElementById('sort').addEventListener('click', () => { for (let k = 0; k < 5; k++) render([...rows].sort((a, b) => a.value - b.value)); document.getElementById('sort').setAttribute('aria-pressed', 'true'); });`,
  '/js/chart.js': `const c = document.getElementById('chart'); const g = c.getContext('2d'); let t = 0;
function frame() { t++; g.clearRect(0, 0, c.width, c.height); g.beginPath(); for (let x = 0; x < c.width; x++) g.lineTo(x, 100 + 80 * Math.sin((x + t) / 30)); g.stroke(); requestAnimationFrame(frame); }
requestAnimationFrame(frame);`,
};

const svg = (w, h) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#6a9"/>${'<circle cx="10" cy="10" r="5"/>'.repeat(Math.min(400, Math.round((w * h) / 20000)))}</svg>`;

export async function startFixtureSite({ port = 8082, host = '127.0.0.1' } = {}) {
  const site = `http://www.site.test:${port}`;
  const server = http.createServer((req, res) => {
    const reqHost = (req.headers.host || '').split(':')[0];
    const path = req.url.split('?')[0];
    const send = (status, type, body) => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(body);
    };
    if (reqHost === 'thirdparty.test') {
      if (path === '/widget') return send(200, 'text/html; charset=utf-8', '<!doctype html><html lang="en"><head><title>Widget</title><script src="/widget.js"></script></head><body><p>Third-party widget</p></body></html>');
      if (path === '/widget.js') return send(200, 'text/javascript', 'setInterval(() => { document.body.dataset.tick = String(Date.now()); }, 500);');
      return send(404, 'text/plain', 'not found');
    }
    if (path === '/robots.txt') return send(200, 'text/plain', `User-agent: *\nAllow: /\nSitemap: ${site}/sitemap.xml\n`);
    if (path === '/sitemap.xml') {
      return send(200, 'application/xml', `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${[...Object.keys(PAGES), ...Object.keys(FILES)].map((p) => `<url><loc>${site}${p}</loc></url>`).join('')}</urlset>`);
    }
    if (path === '/css/site.css') return send(200, 'text/css', 'body{font-family:system-ui,sans-serif;margin:0 auto;max-width:60rem;padding:1rem}nav ul{display:flex;gap:1rem;list-style:none;padding:0}article[data-component-id=card]{display:inline-block;width:12rem;margin:.5rem;vertical-align:top}');
    if (SCRIPTS[path]) return send(200, 'text/javascript', SCRIPTS[path]);
    if (FILES[path]) return send(200, FILES[path][0], FILES[path][1]);
    if (path === '/css/big.css') return send(200, 'text/css', `.used{color:#036}\n${Array.from({ length: 4000 }, (_, i) => `.unused-${i} .deep .chain > li:not(.x){margin:${i % 7}px;padding:${i % 5}px}`).join('\n')}`);
    if (path === '/js/big.js') {
      return send(200, 'text/javascript', `${Array.from({ length: 3000 }, (_, i) => `function unused${i}(a){return a*${i}+Math.sqrt(a+${i});}`).join('\n')}\nwindow.bigReady = unused1(2);`);
    }
    if (path === '/img/huge.svg') return send(200, 'image/svg+xml', svg(2400, 1600));
    if (path.startsWith('/img/')) return send(200, 'image/svg+xml', svg(120, 80));
    if (path === '/search') {
      const q = new URL(req.url, site).searchParams.get('q') ?? '';
      const results = q ? Array.from({ length: 10 }, (_, i) => `<li><a href="/articles/a">Result ${i + 1} for ${q.replace(/[<>&"]/g, '')}</a></li>`).join('') : '';
      return send(200, 'text/html; charset=utf-8', page('Search', `<section aria-label="Search results" data-component-id="search-results"><ol>${results}</ol></section>`));
    }
    const html = PAGES[path];
    if (html) return send(200, 'text/html; charset=utf-8', html.replace('PORT', String(port)));
    return send(404, 'text/html; charset=utf-8', page('Page not found', '<p>Nothing is at this address.</p>'));
  });
  await new Promise((resolve) => server.listen(port, host, resolve));
  return { url: site, port, pages: Object.keys(PAGES), close: () => new Promise((r) => server.close(r)) };
}
