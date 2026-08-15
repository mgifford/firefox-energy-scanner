/* Firefox Energy Scanner — client-side rendering of published results.
   No dependencies. The site is static; results come from results/index.json. */

(function () {
  'use strict';

  const REPO = 'mgifford/firefox-energy-scanner';
  const MAX_URLS = 20;

  /* ---------------------------------------------------------------- form */

  const form = document.getElementById('scan-form');
  const status = document.getElementById('form-status');

  /**
   * Only public http(s) URLs are accepted. Localhost and private ranges are
   * rejected because a hosted runner cannot reach them, and accepting them
   * would invite pointing the scanner at internal hosts.
   */
  function validateUrls(raw) {
    const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return { error: 'Enter at least one URL.' };
    if (lines.length > MAX_URLS) {
      return { error: 'Maximum ' + MAX_URLS + ' URLs per request (got ' + lines.length + ').' };
    }
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

  if (form) {
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      status.textContent = '';

      const result = validateUrls(document.getElementById('urls').value);
      if (result.error) {
        status.textContent = result.error;
        document.getElementById('urls').focus();
        return;
      }

      const title = document.getElementById('title').value.trim();
      if (!title) {
        status.textContent = 'Add a short description for the issue title.';
        document.getElementById('title').focus();
        return;
      }

      const runner = (document.querySelector('input[name="runner"]:checked') || {}).value || 'macos';
      const runs = document.getElementById('runs').value || '8';

      const body = [
        '### URLs',
        '',
        result.urls.join('\n'),
        '',
        '### Runner',
        '',
        runner,
        '',
        '### Measured runs',
        '',
        String(runs),
        '',
      ].join('\n');

      const url =
        'https://github.com/' + REPO + '/issues/new' +
        '?template=scan-request.yml' +
        '&title=' + encodeURIComponent('SCAN: ' + title) +
        '&urls=' + encodeURIComponent(result.urls.join('\n')) +
        '&runner=' + encodeURIComponent(runner) +
        '&runs=' + encodeURIComponent(String(runs));

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
    text(meta, bits.join(' · '));
    head.appendChild(meta);
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
      if (mwh && s.resolved) {
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

    if (entry.runnerNote) {
      const p = make('p', 'run-warning');
      text(p, entry.runnerNote);
      wrap.appendChild(p);
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

  function load() {
    fetch('results/index.json', { cache: 'no-cache' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        entries = (data && data.entries) || [];
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
