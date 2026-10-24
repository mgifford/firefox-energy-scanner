/* Firefox Energy Scanner — client-side rendering of published results.
   No dependencies. The site is static; results come from results/index.json. */

(function () {
  'use strict';

  const REPO = 'mgifford/firefox-energy-scanner';
  const MAX_URLS = 200;

  /* ---------------------------------------------------------------- form */

  const form = document.getElementById('scan-form');
  const status = document.getElementById('form-status');

  // Must match the issue template's option labels exactly: the parser reads
  // the label text (tests/issue-parser.test.ts checks every option).
  const LABELS = {
    lighthouse: {
      'performance-top': 'Performance — the 10 heaviest pages',
      'performance-every': 'Performance — every page (slower)',
      'all-top': 'All categories — the 10 heaviest pages',
      none: 'No',
    },
    what: {
      auto: 'Auto — one URL crawls its site; several URLs scan just those',
      only: 'Only the listed URLs',
      crawl: 'Crawl the site from the first URL',
    },
    where: {
      auto: "Auto — an energy-measuring machine if one is set up, otherwise GitHub's cloud",
      cloud: "GitHub's cloud only (no energy)",
    },
  };

  /**
   * Only public http(s) URLs are accepted. Localhost and private ranges are
   * rejected because a hosted runner cannot reach them, and accepting them
   * would invite pointing the scanner at internal hosts. The server checks
   * again; this is for immediate feedback.
   */
  function validateUrls(raw) {
    const lines = raw.split(/[\n,]+/).map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return { error: 'Enter at least one URL.' };
    const bad = [];
    for (const line of lines) {
      let u;
      try {
        u = new URL(line);
      } catch (_) {
        bad.push(line);
        continue;
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') { bad.push(line); continue; }
      const h = u.hostname.toLowerCase();
      const isPrivate =
        h === 'localhost' ||
        h === '::1' ||
        h.endsWith('.localhost') ||
        h.endsWith('.local') ||
        /^127\./.test(h) ||
        /^10\./.test(h) ||
        /^192\.168\./.test(h) ||
        /^169\.254\./.test(h) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(h);
      if (isPrivate) bad.push(line);
    }
    if (bad.length > 0) {
      return { error: 'Not public web URLs: ' + bad.slice(0, 3).join(', ') + (bad.length > 3 ? '…' : '') };
    }
    return { urls: lines };
  }

  function value(id, fallback) {
    const el = document.getElementById(id);
    return (el && el.value) || fallback;
  }

  /** Mirrors chooseMode() in issue-parser.ts. */
  function willCrawl(urlCount) {
    const what = value('what', 'auto');
    return what === 'crawl' || (what === 'auto' && urlCount === 1);
  }

  /**
   * Mirrors estimateMinutes() in issue-parser.ts for GitHub's cloud: one visit
   * per page (~4.4 s), plus ~25 s per Lighthouse page.
   */
  function estimateMinutes(urlCount, pages, lighthouse) {
    const crawl = willCrawl(urlCount);
    const scanned = crawl ? pages : Math.min(urlCount, MAX_URLS);
    const audited = lighthouse === 'none' ? 0
      : lighthouse === 'performance-every' ? scanned : Math.min(scanned, 10);
    return (15 + scanned * 4.4 + audited * 25) / 60;
  }

  function updateEstimate() {
    const el = document.getElementById('estimate');
    if (!el) return;
    const listed = (value('urls', '')).split(/[\n,]+/).map(function (s) { return s.trim(); }).filter(Boolean).length;
    if (listed === 0) { el.textContent = ''; return; }
    const pages = parseInt(value('max-pages', '50'), 10) || 50;
    const minutes = estimateMinutes(listed, pages, value('lighthouse', 'performance-top'));
    const rounded = minutes < 1 ? '<1' : String(Math.round(minutes));
    const what = willCrawl(listed)
      ? 'Crawls the site from that URL, up to ' + pages + ' pages.'
      : 'Scans ' + Math.min(listed, MAX_URLS) + ' listed page' + (listed === 1 ? '' : 's') + '.' +
        (listed > MAX_URLS ? ' The other ' + (listed - MAX_URLS) + ' will be listed as not scanned.' : '');
    el.textContent = what + ' About ' + rounded + ' minute' + (rounded === '1' ? '' : 's') + '.';
    el.className = 'estimate';
  }

  if (form) {
    ['urls', 'max-pages'].forEach(function (id) {
      const el = document.getElementById(id);
      if (el) el.addEventListener('input', updateEstimate);
    });
    ['lighthouse', 'what', 'where'].forEach(function (id) {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', updateEstimate);
    });
    updateEstimate();

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      status.textContent = '';

      const result = validateUrls(value('urls', ''));
      if (result.error) {
        status.textContent = result.error;
        document.getElementById('urls').focus();
        return;
      }

      const title = value('title', '').trim();
      if (!title) {
        status.textContent = 'Add a short description for the issue title.';
        document.getElementById('title').focus();
        return;
      }

      // Field ids here must match the issue template's field ids so GitHub
      // pre-fills the form correctly.
      const params = new URLSearchParams();
      params.set('template', 'scan-request.yml');
      params.set('title', 'SCAN: ' + title);
      params.set('urls', result.urls.join('\n'));
      params.set('lighthouse', LABELS.lighthouse[value('lighthouse', 'performance-top')]);
      params.set('viewport', value('viewport', 'Desktop (1280x800)'));
      params.set('what', LABELS.what[value('what', 'auto')]);
      params.set('max-pages', String(parseInt(value('max-pages', '50'), 10) || 50));
      params.set('where', LABELS.where[value('where', 'auto')]);

      const url = 'https://github.com/' + REPO + '/issues/new?' + params.toString();

      // Opening a new tab keeps the form state intact if the user comes back.
      // GitHub asks them to review and submit, so nothing is filed silently.
      window.open(url, '_blank', 'noopener');
      status.textContent =
        'A GitHub issue form has opened in a new tab. Review it and press "Create" to queue the scan.';
    });
  }

  /* ------------------------------------------------------------- results */

  const container = document.getElementById('results-container');
  const resultsStatus = document.getElementById('results-status');
  const filterInput = document.getElementById('filter');
  const sortSelect = document.getElementById('sort');

  let entries = [];

  function text(el, value) { el.textContent = value == null ? '' : String(value); return el; }
  function make(tag, className) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    return el;
  }

  function fmtBytes(n) {
    if (!isFinite(n) || n <= 0) return '—';
    return n >= 1024 * 1024
      ? (n / 1024 / 1024).toFixed(2) + ' MB'
      : (n / 1024).toFixed(0) + ' KB';
  }
  function fmtMg(g) {
    return isFinite(g) ? (g * 1000).toFixed(3) + ' mg' : '—';
  }
  function fmtMwh(v) {
    return typeof v === 'number' && isFinite(v) ? v.toFixed(3) + ' mWh' : null;
  }

  function scenarioSortValue(entry, key) {
    const vals = entry.scenarios.map(function (s) {
      if (key === 'energy') return typeof s.energyMwh === 'number' ? s.energyMwh : -Infinity;
      if (key === 'co2') return typeof s.co2Grams === 'number' ? s.co2Grams : -Infinity;
      if (key === 'bytes') return s.transferBytes;
      if (key === 'requests') return s.requests;
      return -Infinity;
    });
    return vals.length ? Math.max.apply(null, vals) : -Infinity;
  }

  function renderEntry(entry) {
    const wrap = make('article', 'run');

    const head = make('div', 'run-head');
    const h3 = make('h3');
    h3.appendChild(document.createTextNode(entry.targetLabel || entry.target || entry.mode));

    const badge = make('span', 'badge ' + (entry.energyAvailable ? 'badge-energy' : 'badge-noenergy'));
    text(badge, entry.energyAvailable ? 'energy measured' : 'no energy data');
    h3.appendChild(badge);
    head.appendChild(h3);

    const meta = make('p', 'run-meta');
    const bits = [
      new Date(entry.timestamp).toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
      entry.platform + '/' + entry.architecture,
      entry.mode,
    ];
    if (entry.firefoxVersion) bits.push('Firefox ' + entry.firefoxVersion);
    if (entry.onBattery) bits.push('on battery');
    if (entry.lowPowerMode) bits.push('Low Power Mode ON');
    if (entry.tier) bits.push(entry.tier + ' tier');
    text(meta, bits.join(' · '));
    head.appendChild(meta);

    // State plainly what this host could not measure, so an absent energy
    // figure is never read as a measured zero.
    if (entry.tierSummary && entry.tier === 'structural') {
      const note = make('p', 'tier-note');
      text(note, entry.tierSummary);
      head.appendChild(note);
    }
    wrap.appendChild(head);

    const scroll = make('div', 'table-scroll');
    const table = make('table');

    const caption = make('caption');
    text(
      caption,
      'Median values across measured runs. Modelled CO2e and observed energy have ' +
        'different system boundaries and are not interchangeable.'
    );
    table.appendChild(caption);

    const thead = make('thead');
    const hr = make('tr');
    ['Scenario', 'Runs', 'Transfer', 'Requests', '3rd party', 'Duration', 'CO2.js', 'Observed energy']
      .forEach(function (label) {
        const th = make('th');
        th.setAttribute('scope', 'col');
        text(th, label);
        hr.appendChild(th);
      });
    thead.appendChild(hr);
    table.appendChild(thead);

    const tbody = make('tbody');
    entry.scenarios.forEach(function (s) {
      const tr = make('tr');

      const th = make('th');
      th.setAttribute('scope', 'row');
      text(th, s.step.length > 46 ? '…' + s.step.slice(-44) : s.step);
      tr.appendChild(th);

      // A failed URL has no page behind it; show no numbers rather than ones
      // that describe some other page.
      if (s.failed) {
        const td = make('td', 'unresolved failed-note');
        td.colSpan = 7;
        text(td, s.notAPage
          ? 'Not a web page — the URL starts a file download (usually a PDF), so there was nothing to measure.'
          : (s.failureNote || 'Every measured run failed.'));
        tr.appendChild(td);
        tbody.appendChild(tr);
        return;
      }

      [
        String(s.runs),
        fmtBytes(s.transferBytes),
        String(s.requests),
        String(s.thirdPartyRequests),
        s.durationMs + ' ms',
        fmtMg(s.co2Grams),
      ].forEach(function (v) {
        const td = make('td');
        text(td, v);
        tr.appendChild(td);
      });

      const energyCell = make('td');
      const mwh = fmtMwh(s.energyMwh);
      if (!entry.energyAvailable) {
        // No power hardware on this host: nothing was measured. That is not
        // the same claim as "measured but below the noise floor".
        energyCell.className = 'unresolved';
        text(energyCell, 'not measured');
      } else if (mwh && s.resolved) {
        text(energyCell, mwh);
      } else {
        energyCell.className = 'unresolved';
        text(energyCell, s.resolved ? '—' : 'not resolved');
        if (s.resolutionNote) energyCell.title = s.resolutionNote;
      }
      tr.appendChild(energyCell);

      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    scroll.appendChild(table);
    wrap.appendChild(scroll);

    // Structure and findings need no power hardware, so they appear on every
    // host — this is the bulk of the actionable output on a hosted runner.
    entry.scenarios.forEach(function (s) {
      const anatomy = anatomyNode(s);
      const findings = findingsNode(s);
      const lighthouse = lighthouseNode(s.lighthouse, entry.lighthouse);
      if (!anatomy && !findings && !lighthouse) return;
      const section = make('div', 'scenario-detail');
      const label = make('p', 'scenario-detail-label');
      text(label, s.step.length > 60 ? '…' + s.step.slice(-58) : s.step);
      section.appendChild(label);
      if (anatomy) section.appendChild(anatomy);
      if (findings) section.appendChild(findings);
      if (lighthouse) section.appendChild(lighthouse);
      wrap.appendChild(section);
    });

    if (entry.lighthouse) wrap.appendChild(lighthouseSitewideNode(entry));

    if (entry.runnerNote) {
      const p = make('p', 'run-warning');
      text(p, entry.runnerNote);
      wrap.appendChild(p);
    }
    const check = entry.energyCheck;
    if (!entry.energyAvailable && check && check.nextSteps && check.nextSteps.length) {
      const details = make('details', 'findings');
      const summary = make('summary');
      text(summary, 'Where energy can be measured');
      details.appendChild(summary);
      const ul = make('ul');
      check.nextSteps.forEach(function (step) {
        const li = make('li');
        appendWithCode(li, step);
        ul.appendChild(li);
      });
      details.appendChild(ul);
      wrap.appendChild(details);
    }
    (entry.warnings || []).slice(0, 3).forEach(function (w) {
      const p = make('p', 'run-warning');
      text(p, w);
      wrap.appendChild(p);
    });

    return wrap;
  }

  function render() {
    const q = (filterInput.value || '').toLowerCase().trim();
    const key = sortSelect.value;

    let visible = entries;
    if (q) {
      visible = entries.filter(function (e) {
        const hay = [e.target, e.targetLabel, e.mode]
          .concat(e.scenarios.map(function (s) { return s.step; }))
          .join(' ')
          .toLowerCase();
        return hay.indexOf(q) !== -1;
      });
    }

    visible = visible.slice().sort(function (a, b) {
      if (key === 'timestamp') return a.timestamp < b.timestamp ? 1 : -1;
      return scenarioSortValue(b, key) - scenarioSortValue(a, key);
    });

    container.innerHTML = '';
    if (visible.length === 0) {
      resultsStatus.textContent = entries.length
        ? 'No results match "' + q + '".'
        : 'No results published yet. Request a scan above to add the first one.';
      return;
    }
    resultsStatus.textContent =
      'Showing ' + visible.length + ' of ' + entries.length + ' published scan' +
      (entries.length === 1 ? '' : 's') + '.';
    visible.forEach(function (e) { container.appendChild(renderEntry(e)); });
  }

  /**
   * Headline counts. "Resolvable energy" is shown deliberately: it is the share
   * of measured scenarios where energy rose above the noise floor, which is the
   * honest indicator of how much of this data can actually be used.
   */
  /**
   * Structural findings, available on every host regardless of energy hardware.
   * Built as DOM nodes rather than HTML strings: selectors and titles come from
   * scanned pages and are untrusted.
   */
  function findingsNode(scenario) {
    if (!scenario.findings || scenario.findings.length === 0) return null;
    const details = make('details', 'findings');
    const summary = make('summary');
    text(summary, scenario.findings.length + ' structural finding' +
      (scenario.findings.length === 1 ? '' : 's'));
    details.appendChild(summary);

    const ul = make('ul');
    scenario.findings.forEach(function (f) {
      const li = make('li');
      const sev = make('strong');
      text(sev, f.severity.toUpperCase());
      li.appendChild(sev);
      li.appendChild(document.createTextNode(' ' + f.title));
      li.appendChild(make('br'));
      const action = make('span', 'muted');
      text(action, f.action);
      li.appendChild(action);
      ul.appendChild(li);
    });
    details.appendChild(ul);
    return details;
  }

  /** Render `backticked` spans as <code>, everything else as text. */
  function appendWithCode(el, value) {
    String(value).split('`').forEach(function (part, i) {
      if (!part) return;
      if (i % 2 === 1) {
        const c = make('code');
        text(c, part);
        el.appendChild(c);
      } else {
        el.appendChild(document.createTextNode(part));
      }
    });
  }

  function rating(score) {
    if (typeof score !== 'number') return 'no score';
    return score >= 90 ? 'good' : score >= 50 ? 'needs improvement' : 'poor';
  }
  function fmtSec(ms) {
    return typeof ms === 'number' ? (ms / 1000).toFixed(1) + ' s' : '—';
  }

  /**
   * Lighthouse result for one URL. The rating is always written out, so the
   * score is never conveyed by colour alone. Built from DOM nodes: values come
   * from scanned pages and are untrusted.
   */
  function lighthouseNode(r, meta) {
    if (!r) return null;
    const details = make('details', 'lighthouse');
    const summary = make('summary');
    if (r.error && !r.runs) {
      text(summary, 'Lighthouse: failed');
      details.appendChild(summary);
      const p = make('p', 'muted');
      text(p, r.error);
      details.appendChild(p);
      return details;
    }
    const perf = r.scores && r.scores.performance;
    const range = r.performanceRange && r.performanceRange[0] !== r.performanceRange[1]
      ? ' (range ' + r.performanceRange[0] + '–' + r.performanceRange[1] + ')' : '';
    text(summary, 'Lighthouse performance ' + (typeof perf === 'number' ? perf : '—') +
      '/100, ' + rating(perf) + range +
      (r.recommendations.length ? ' · ' + r.recommendations.length + ' recommendation' +
        (r.recommendations.length === 1 ? '' : 's') : ''));
    details.appendChild(summary);

    const dl = make('dl', 'lh-metrics');
    const add = function (k, v) {
      const dt = make('dt'); text(dt, k); dl.appendChild(dt);
      const dd = make('dd'); text(dd, v); dl.appendChild(dd);
    };
    add('Largest Contentful Paint', fmtSec(r.metrics.lcpMs));
    add('Total Blocking Time', typeof r.metrics.tbtMs === 'number' ? r.metrics.tbtMs + ' ms' : '—');
    add('Cumulative Layout Shift', r.metrics.cls != null ? String(r.metrics.cls) : '—');
    add('First Contentful Paint', fmtSec(r.metrics.fcpMs));
    add('Speed Index', fmtSec(r.metrics.speedIndexMs));
    if (typeof r.mainThreadMs === 'number') add('Main-thread work', fmtSec(r.mainThreadMs));
    if (typeof r.totalBytes === 'number') add('Total byte weight', fmtBytes(r.totalBytes));
    [['accessibility', 'Accessibility'], ['best-practices', 'Best practices'], ['seo', 'SEO']].forEach(function (pair) {
      const c = pair[0];
      if (r.scores && typeof r.scores[c] === 'number') {
        const failing = r.failing && r.failing[c];
        add(pair[1] + ' score', r.scores[c] + '/100' +
          (failing ? ' (' + failing + ' failing audit' + (failing === 1 ? '' : 's') + ')' : ''));
      }
    });
    details.appendChild(dl);

    if (r.recommendations.length) {
      const h = make('p', 'lh-subhead');
      text(h, 'Recommendations, most impactful first');
      details.appendChild(h);
      const ol = make('ol');
      r.recommendations.forEach(function (rec) {
        const li = make('li');
        if (rec.learnMore && /^https:\/\//.test(rec.learnMore)) {
          const a = make('a');
          a.href = rec.learnMore;
          text(a, rec.title);
          li.appendChild(a);
        } else {
          li.appendChild(document.createTextNode(rec.title));
        }
        if (rec.displayValue) {
          const span = make('span', 'muted');
          text(span, ' — ' + rec.displayValue);
          li.appendChild(span);
        }
        ol.appendChild(li);
      });
      details.appendChild(ol);
    }

    if (meta) {
      const note = make('p', 'muted lh-note');
      text(note, 'Lighthouse ' + meta.version + ', ' + (meta.browser || 'Chromium') + ', ' +
        meta.formFactor + ' profile, ' + meta.throttling + '. Median of ' + meta.runsPerUrl +
        ' run' + (meta.runsPerUrl === 1 ? '' : 's') + '.');
      details.appendChild(note);
    }
    return details;
  }

  /** Recommendations shared across pages: usually one template-level fix. */
  function lighthouseSitewideNode(entry) {
    const lh = entry.lighthouse;
    const section = make('div', 'scenario-detail');
    const label = make('p', 'scenario-detail-label');
    text(label, 'Lighthouse across all audited pages');
    section.appendChild(label);
    const note = make('p', 'muted lh-note');
    text(note, 'Lighthouse runs Chromium under simulated throttling. It measures lab load ' +
      'performance — not Firefox and not energy — and is shown beside those results, never combined with them.');
    section.appendChild(note);
    if (!lh.sitewide || lh.sitewide.length === 0) return section;
    const audited = entry.scenarios.filter(function (s) { return s.lighthouse && s.lighthouse.runs; }).length +
      (lh.unmatched || []).filter(function (r) { return r.runs; }).length;
    const ul = make('ul', 'lh-sitewide');
    lh.sitewide.forEach(function (x) {
      const li = make('li');
      const strong = make('strong');
      text(strong, x.title);
      li.appendChild(strong);
      const bits = [x.pages + ' of ' + audited + ' page' + (audited === 1 ? '' : 's')];
      if (x.medianSavingsMs) bits.push('est. ' + fmtSec(x.medianSavingsMs) + ' per page');
      if (x.medianSavingsBytes) bits.push('est. ' + fmtBytes(x.medianSavingsBytes) + ' per page');
      li.appendChild(document.createTextNode(' — ' + bits.join(' · ')));
      ul.appendChild(li);
    });
    section.appendChild(ul);
    return section;
  }

  function anatomyNode(scenario) {
    const a = scenario.anatomy;
    if (!a) return null;
    const bits = [
      a.domNodes + ' nodes (depth ' + a.domDepth + ')',
      a.cssSelectors + ' selectors',
      a.scripts + ' scripts',
      a.images + ' images',
    ];
    if (a.animatedElements) bits.push(a.animatedElements + ' animated');
    if (a.lcpElement) bits.push('LCP: ' + a.lcpElement);
    if (a.heaviestSubtree) bits.push('heaviest: ' + a.heaviestSubtree);
    const p = make('p', 'anatomy muted');
    text(p, bits.join(' \u00b7 '));
    return p;
  }

  function renderStats() {
    const set = function (id, value) {
      const el = document.getElementById(id);
      if (el) el.textContent = value;
    };
    if (entries.length === 0) return;

    let scenarios = 0;
    let measured = 0;
    let resolved = 0;
    entries.forEach(function (e) {
      e.scenarios.forEach(function (s) {
        if (s.failed) return;
        scenarios++;
        // Only scans that could measure energy count toward resolvability;
        // a host with no power hardware did not fail to resolve anything.
        if (!e.energyAvailable) return;
        measured++;
        if (s.resolved) resolved++;
      });
    });

    set('stat-scans', String(entries.length));
    set('stat-pages', String(scenarios));
    set('stat-resolved', measured ? Math.round((resolved / measured) * 100) + '%' : 'no energy scans yet');
    const recent = entries[0] && entries[0].timestamp;
    set('stat-recent', recent ? new Date(recent).toISOString().slice(0, 10) : '—');
  }

  function load() {
    fetch('results/index.json', { cache: 'no-cache' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        entries = (data && data.entries) || [];
        renderStats();
        render();
      })
      .catch(function () {
        resultsStatus.textContent =
          'No results published yet. Request a scan above to add the first one.';
      });
  }

  if (container) {
    filterInput.addEventListener('input', render);
    sortSelect.addEventListener('change', render);
    load();
  }
})();
