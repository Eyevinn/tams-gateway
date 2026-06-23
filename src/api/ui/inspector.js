/*
 * TAMS gateway read-only inspector (ADR-007).
 *
 * Constraint C2 (read-only by construction): the ONLY network helper in this
 * file is getJson() / getText(), which issue GET and nothing else. There is no
 * PUT/POST/DELETE helper anywhere in this bundle, by design. Do not add one.
 *
 * Constraint C1 (no SPA / no bundler): plain vanilla JS, no framework, no build
 * step. Navigation is via real <a href> links in the rendered HTML; this script
 * reads location.search on load and renders the matching view. hls.js is loaded
 * lazily (a vendored same-origin <script>) only on the flow-detail view.
 *
 * Endpoint contracts (confirmed against the gateway source, 2026-06-22):
 *   GET /flows                 -> Flow[] (verbatim docs: id, source_id, label,
 *                                 codec, container, format, tags, timerange, ...)
 *   GET /flows/:id             -> Flow
 *   GET /sources               -> Source[] (id, format, label, tags, ...)
 *   GET /flows/:id/segments    -> { object_id, timerange, sample_count,
 *                                   sample_offset, get_urls }[]
 *   GET /flows/:id/output.m3u8 -> HLS media playlist (200) | 415 non-MPEG-TS
 */

(function () {
  'use strict';

  // The UI is served at /ui/ ; the API is one level up. Resolve relative to the
  // current document so it works under any mount prefix.
  var API_BASE = new URL('../', window.location.href);

  // Visible build stamp: bump on every UI change so a reload visibly confirms
  // the browser picked up fresh JS (not a stale cached bundle).
  var BUILD = 'build 2026-06-23 #26';

  var statusEl = document.getElementById('status');
  var viewEl = document.getElementById('view');

  // Section render functions append through mount() rather than to viewEl
  // directly, so a view can route panels into a column layout (the flow detail
  // puts the player in a wide left column and the metadata + navigator in a
  // right column, see renderFlowDetail). Defaults to viewEl; clearView resets it.
  var mountTarget = viewEl;
  function mount(node) {
    mountTarget.appendChild(node);
  }

  var buildEl = document.getElementById('build');
  if (buildEl) buildEl.textContent = BUILD;

  // --- read-only fetch helpers (GET only) -----------------------------------

  function getJson(path) {
    return fetch(new URL(path, API_BASE).href, {
      method: 'GET',
      headers: { Accept: 'application/json' }
    }).then(function (res) {
      if (!res.ok) {
        var err = new Error('HTTP ' + res.status);
        err.status = res.status;
        throw err;
      }
      return res.json();
    });
  }

  // --- small DOM helpers ----------------------------------------------------

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'text') node.textContent = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (attrs[k] != null) node.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach(function (c) {
      if (c == null) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  // Active hls.js instance + interval timers for the flow-detail player. The
  // player view is rebuilt on every navigation; without explicit teardown the
  // previous hls.js instance keeps its live-manifest reload loop running and the
  // clock/seekbar intervals keep ticking (detached from the cleared DOM), so
  // re-renders leak loops that compound into a live-manifest request storm.
  // teardownPlayer() is called from clearView() before each render.
  var currentHls = null;
  var playerTimers = [];
  function teardownPlayer() {
    if (currentHls) {
      try {
        currentHls.destroy();
      } catch (e) {
        /* already gone */
      }
      currentHls = null;
    }
    while (playerTimers.length) clearInterval(playerTimers.pop());
  }

  function clearView() {
    teardownPlayer();
    viewEl.innerHTML = '';
    mountTarget = viewEl;
  }

  function setStatus(text, isError) {
    statusEl.className = isError ? 'status error' : 'status';
    statusEl.textContent = text || '';
  }

  function notice(kind, text) {
    return el('p', { class: 'notice ' + kind, text: text });
  }

  // --- timerange parsing (for segment discontinuity) ------------------------
  // Segment timerange is the TAMS string "[<sec>:<ns>_<sec>:<ns>)". The /segments
  // endpoint does not expose raw ts_start/ts_end, so we parse the string to spot
  // a gap (segment[i].start !== segment[i-1].end) per ADR-007 D7.

  function tsToNs(ts) {
    // ts = "<sec>:<ns>"
    var parts = ts.split(':');
    var sec = BigInt(parts[0]);
    var ns = BigInt(parts[1] || '0');
    return sec * 1000000000n + ns;
  }

  function parseSegmentRange(timerange) {
    // strip brackets, split on '_'
    var inner = timerange.replace(/^[[(]/, '').replace(/[\])]$/, '');
    var bits = inner.split('_');
    if (bits.length !== 2 || bits[0] === '' || bits[1] === '') return null;
    try {
      return { start: tsToNs(bits[0]), end: tsToNs(bits[1]) };
    } catch (e) {
      return null;
    }
  }

  function durationSeconds(range) {
    if (!range) return null;
    return Number(range.end - range.start) / 1e9;
  }

  var NS_PER_MS = 1000000n;
  var NS_PER_S = 1000000000n;
  // TAMS timestamps are TAI, which is 37s ahead of UTC (constant since 2017 — no
  // leap seconds since). Subtract it so the displayed wall-clock is civil local
  // time, matching e.g. the timecode burnt into the video feed, not TAI+37s.
  var TAI_UTC_OFFSET_MS = 37000;

  // Render a TAI nanosecond instant as civil local wall-clock time.
  function nsToLocal(ns) {
    if (ns == null) return '-';
    var d = new Date(Number(ns / NS_PER_MS) - TAI_UTC_OFFSET_MS);
    return d.toLocaleString();
  }

  // Render a nanosecond instant as a TAMS "sec:ns" timestamp (for building the
  // next-page timerange cursor).
  function nsToTai(ns) {
    return String(ns / NS_PER_S) + ':' + String(ns % NS_PER_S);
  }

  // --- 10-minute window navigation -----------------------------------------
  // The navigator browses the recording in fixed 10-minute windows so the UI
  // never loads the whole-recording VOD playlist. A window is identified by its
  // TAI epoch SECOND start; the window covers [start, start+600s).
  var WINDOW_SEC = 600;

  // Civil-local wall-clock ms for a TAI nanosecond instant (matches nsToLocal:
  // TAI is 37s ahead of UTC, so subtract the offset to read civil time).
  function nsToCivilMs(ns) {
    return Number(ns / NS_PER_MS) - TAI_UTC_OFFSET_MS;
  }

  // Civil-local ms -> TAI epoch seconds (the window-start identifier carried in
  // the ?start= URL param). Inverse of nsToCivilMs at second granularity.
  function civilMsToTaiSec(civilMs) {
    return Math.floor((civilMs + TAI_UTC_OFFSET_MS) / 1000);
  }

  // Build the output.m3u8 timerange query string for the 10-minute window that
  // starts at the given TAI epoch second: "[<sec:ns>_<sec:ns>)".
  function windowTimerangeQuery(startSec) {
    var startNs = BigInt(startSec) * NS_PER_S;
    var endNs = (BigInt(startSec) + BigInt(WINDOW_SEC)) * NS_PER_S;
    return (
      'timerange=' +
      encodeURIComponent('[' + nsToTai(startNs) + '_' + nsToTai(endNs) + ')')
    );
  }

  // Furthest seekable position: duration for VOD, else the end of the seekable
  // range (the open live DVR window). 0 before anything is loaded.
  function seekEnd(video) {
    if (isFinite(video.duration) && video.duration > 0) return video.duration;
    try {
      return video.seekable && video.seekable.length
        ? video.seekable.end(video.seekable.length - 1)
        : 0;
    } catch (e) {
      return 0;
    }
  }

  // How far behind wall-clock the given instant is, as a human label, so the
  // viewer can sense how long ago the material was current. Called with a
  // TAI-corrected (civil) delta; near-zero/negative reads as the live edge.
  function behindLabel(ms) {
    if (ms < 2000) return 'at live edge';
    var s = Math.round(ms / 1000);
    if (s < 90) return s + 's behind';
    var m = Math.round(s / 60);
    if (m < 90) return m + ' min behind';
    var h = Math.round(m / 60);
    if (h < 36) return h + ' h behind';
    return Math.round(h / 24) + ' d behind';
  }

  // --- playability classification (ADR-007 D7 / ADR-006 D4) -----------------
  // The /flows payload carries codec + container, so we can show a "Playable"
  // badge from the list response with no per-row request (confirmed in
  // listFlows.ts: docs are returned verbatim).

  function isPlayable(flow) {
    var mp2t = function (v) {
      return typeof v === 'string' && v.indexOf('video/mp2t') === 0;
    };
    return (
      mp2t(flow.codec) ||
      mp2t(flow.container) ||
      (flow.container_mapping != null &&
        flow.container_mapping.mp2ts_container != null)
    );
  }

  // ==========================================================================
  // Views
  // ==========================================================================

  function markActiveTab(tab) {
    document.querySelectorAll('nav.tabs a').forEach(function (a) {
      if (a.getAttribute('data-tab') === tab) {
        a.setAttribute('aria-current', 'page');
      } else {
        a.removeAttribute('aria-current');
      }
    });
  }

  function renderFlowsList(filterSourceId) {
    markActiveTab('flows');
    setStatus('Loading flows…');
    getJson('flows')
      .then(function (flows) {
        clearView();
        setStatus('');
        var shown = filterSourceId
          ? flows.filter(function (f) {
              return f.source_id === filterSourceId;
            })
          : flows;

        if (filterSourceId) {
          viewEl.appendChild(
            el('p', { class: 'crumbs' }, [
              el('a', { href: '?tab=sources', text: 'Sources' }),
              ' / flows for source ',
              el('span', { class: 'mono', text: filterSourceId })
            ])
          );
        }

        viewEl.appendChild(
          el('h2', {
            text: filterSourceId ? 'Flows in source' : 'Flows'
          })
        );

        if (shown.length === 0) {
          viewEl.appendChild(
            notice(
              'empty',
              filterSourceId
                ? 'No flows belong to this source.'
                : 'No flows yet. Flows appear here once a producer registers them.'
            )
          );
          return;
        }

        var rows = shown.map(function (f) {
          var playable = isPlayable(f);
          return el('tr', null, [
            el('td', null, [
              el('a', {
                href: '?flow=' + encodeURIComponent(f.id),
                text: f.label || f.id,
                class: f.label ? null : 'mono'
              })
            ]),
            el('td', { class: 'mono', text: f.id }),
            el('td', { class: 'mono', text: f.codec || '-' }),
            el('td', { text: f.format || '-' }),
            el('td', null, [
              playable
                ? el('span', { class: 'badge playable', text: 'Playable' })
                : el('span', {
                    class: 'badge not-playable',
                    text: 'Not playable',
                    title: 'Only MPEG-TS flows can play in this inspector'
                  })
            ])
          ]);
        });

        viewEl.appendChild(
          el('table', null, [
            el('caption', {
              text: shown.length + (shown.length === 1 ? ' flow' : ' flows')
            }),
            el('thead', null, [
              el('tr', null, [
                el('th', { scope: 'col', text: 'Flow' }),
                el('th', { scope: 'col', text: 'ID' }),
                el('th', { scope: 'col', text: 'Codec' }),
                el('th', { scope: 'col', text: 'Format' }),
                el('th', { scope: 'col', text: 'Playback' })
              ])
            ]),
            el('tbody', null, rows)
          ])
        );
      })
      .catch(function (err) {
        renderError(err, 'flows');
      });
  }

  function renderSourcesList() {
    markActiveTab('sources');
    setStatus('Loading sources…');
    getJson('sources')
      .then(function (sources) {
        clearView();
        setStatus('');
        viewEl.appendChild(el('h2', { text: 'Sources' }));

        if (sources.length === 0) {
          viewEl.appendChild(notice('empty', 'No sources yet.'));
          return;
        }

        var rows = sources.map(function (s) {
          return el('tr', null, [
            el('td', null, [
              // Sources link into a filtered flows view (ADR-007 D7: no
              // separate source-detail page).
              el('a', {
                href: '?source=' + encodeURIComponent(s.id),
                text: s.label || s.id,
                class: s.label ? null : 'mono'
              })
            ]),
            el('td', { class: 'mono', text: s.id }),
            el('td', { text: s.format || '-' })
          ]);
        });

        viewEl.appendChild(
          el('table', null, [
            el('caption', {
              text:
                sources.length + (sources.length === 1 ? ' source' : ' sources')
            }),
            el('thead', null, [
              el('tr', null, [
                el('th', { scope: 'col', text: 'Source' }),
                el('th', { scope: 'col', text: 'ID' }),
                el('th', { scope: 'col', text: 'Format' })
              ])
            ]),
            el('tbody', null, rows)
          ])
        );
      })
      .catch(function (err) {
        renderError(err, 'sources');
      });
  }

  // Discover a flow's first and latest segment cheaply so the navigator can
  // bound its date/hour pickers to the recorded span. Uses the documented
  // reverse_order=true&limit=1 pattern (listSegments.ts) rather than scanning.
  // Returns { firstNs, lastNs } in TAI nanoseconds, or null on empty/failure.
  function discoverSpan(flowId) {
    var base = 'flows/' + encodeURIComponent(flowId) + '/segments?limit=1';
    return Promise.all([
      getJson(base).catch(function () {
        return [];
      }),
      getJson(base + '&reverse_order=true').catch(function () {
        return [];
      })
    ]).then(function (res) {
      var first =
        res[0] && res[0][0] ? parseSegmentRange(res[0][0].timerange) : null;
      var last =
        res[1] && res[1][0] ? parseSegmentRange(res[1][0].timerange) : null;
      if (!first || !last) return null;
      return { firstNs: first.start, lastNs: last.end };
    });
  }

  function renderFlowDetail(flowId, type, start) {
    setStatus('Loading flow…');
    Promise.all([
      getJson('flows/' + encodeURIComponent(flowId)),
      discoverSpan(flowId)
    ])
      .then(function (res) {
        var flow = res[0];
        var span = res[1];
        clearView();
        setStatus('');

        viewEl.appendChild(
          el('p', { class: 'crumbs' }, [
            el('a', { href: '?', text: 'Flows' }),
            ' / ',
            el('span', { class: 'mono', text: flow.id })
          ])
        );
        viewEl.appendChild(el('h2', { text: flow.label || flow.id }));

        var isLive = type === 'live';

        // Resolve the effective window start (TAI epoch seconds). An explicit
        // ?start wins. Otherwise, for the default (non-live) view, default to
        // the LATEST 10-minute window so the UI never loads the whole-recording
        // VOD playlist. Live ignores the window (it serves the live edge).
        var effectiveStart = null;
        if (start != null && start !== '') {
          effectiveStart = Math.floor(Number(start));
          if (!isFinite(effectiveStart)) effectiveStart = null;
        }
        if (effectiveStart == null && !isLive && span) {
          // Latest window: align to the 10-minute window containing the last
          // segment's end, so the default lands on recent material.
          var lastSec = Number(span.lastNs / NS_PER_S);
          effectiveStart = Math.max(0, lastSec - WINDOW_SEC);
        }

        if (isPlayable(flow)) {
          // Wide layout (16:9 desktop): the player fills a large left column,
          // the time navigator + flow metadata sit in a narrower right column,
          // and the segments table spans full width below. Collapses to a
          // single column on narrow / portrait screens (see .detail-grid CSS).
          var colMain = el('div', { class: 'detail-main' });
          var colSide = el('div', { class: 'detail-side' });
          viewEl.appendChild(
            el('div', { class: 'detail-grid' }, [colMain, colSide])
          );

          mountTarget = colMain;
          renderPlayer(flow, isLive ? 'live' : 'window', effectiveStart);

          mountTarget = colSide;
          if (!isLive) {
            renderNavigator(flow.id, span, effectiveStart);
          }
          renderMetaPanel(flow);

          mountTarget = viewEl;
        } else {
          renderMetaPanel(flow);
          viewEl.appendChild(
            notice(
              'cant-play',
              'This flow is not MPEG-TS (codec ' +
                (flow.codec || 'unknown') +
                '), so it cannot play in this inspector. Its metadata and ' +
                'segments are listed below.'
            )
          );
        }

        renderSegments(flow.id);
      })
      .catch(function (err) {
        renderError(err, 'flow');
      });
  }

  // Date + hour + 10-minute window navigator. Real form controls (labelled,
  // keyboard-operable) bounded to the recorded span. Changing any control
  // navigates to ?flow=<id>&start=<taiSec> (a full reload renders that window).
  function renderNavigator(flowId, span, effectiveStart) {
    var section = el('section', { class: 'panel navigator' });
    section.appendChild(el('h2', { text: 'Window' }));

    if (!span) {
      section.appendChild(
        notice('empty', 'No segments stored for this flow yet.')
      );
      mount(section);
      return;
    }

    var firstCivilMs = nsToCivilMs(span.firstNs);
    var lastCivilMs = nsToCivilMs(span.lastNs);

    // The civil-local datetime the controls should currently reflect. Default
    // to the resolved window start (latest window) when no explicit selection.
    var selCivilMs =
      effectiveStart != null
        ? effectiveStart * 1000 - TAI_UTC_OFFSET_MS
        : lastCivilMs;
    var selDate = new Date(selCivilMs);

    // Local YYYY-MM-DD for <input type="date"> (value + min/max).
    function ymd(ms) {
      var d = new Date(ms);
      var pad = function (n) {
        return (n < 10 ? '0' : '') + n;
      };
      return (
        d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      );
    }

    var dateInput = el('input', {
      type: 'date',
      id: 'nav-date',
      class: 'nav-date',
      min: ymd(firstCivilMs),
      max: ymd(lastCivilMs),
      value: ymd(selCivilMs)
    });

    var hourSelect = el('select', { id: 'nav-hour', class: 'nav-hour' });
    for (var h = 0; h < 24; h++) {
      var hh = (h < 10 ? '0' : '') + h;
      hourSelect.appendChild(
        el('option', {
          value: String(h),
          text: hh,
          selected: h === selDate.getHours() ? '' : null
        })
      );
    }

    var minSelect = el('select', { id: 'nav-min', class: 'nav-min' });
    var selTenMin = Math.floor(selDate.getMinutes() / 10) * 10;
    [0, 10, 20, 30, 40, 50].forEach(function (m) {
      var mm = (m < 10 ? '0' : '') + m;
      minSelect.appendChild(
        el('option', {
          value: String(m),
          text: mm,
          selected: m === selTenMin ? '' : null
        })
      );
    });

    // Compose the selected civil window start from the three controls and
    // navigate. A real location.search assignment => full reload => the router
    // renders the chosen window.
    function navigate() {
      var parts = dateInput.value.split('-');
      if (parts.length !== 3) return;
      var d = new Date(
        Number(parts[0]),
        Number(parts[1]) - 1,
        Number(parts[2]),
        Number(hourSelect.value),
        Number(minSelect.value),
        0,
        0
      );
      var taiSec = civilMsToTaiSec(d.getTime());
      window.location.search =
        '?flow=' + encodeURIComponent(flowId) + '&start=' + taiSec;
    }
    dateInput.addEventListener('change', navigate);
    hourSelect.addEventListener('change', navigate);
    minSelect.addEventListener('change', navigate);

    var row = el('div', { class: 'nav-row' }, [
      el('label', { for: 'nav-date', text: 'Date' }),
      dateInput,
      el('label', { for: 'nav-hour', text: 'Hour' }),
      hourSelect,
      el('label', { for: 'nav-min', text: 'Min' }),
      minSelect,
      el('a', {
        class: 'copy',
        href: '?flow=' + encodeURIComponent(flowId) + '&type=live',
        text: 'Live'
      })
    ]);
    section.appendChild(row);

    section.appendChild(
      el('p', {
        class: 'status',
        text:
          'Showing a 10-minute window. Recorded span: ' +
          new Date(firstCivilMs).toLocaleString() +
          ' to ' +
          new Date(lastCivilMs).toLocaleString() +
          '.'
      })
    );

    mount(section);
  }

  function renderMetaPanel(flow) {
    var meta = el('dl', { class: 'meta' });
    var fields = [
      ['ID', flow.id],
      ['Source', flow.source_id],
      ['Label', flow.label],
      ['Description', flow.description],
      ['Codec', flow.codec],
      ['Container', flow.container],
      ['Format', flow.format],
      ['Timerange', flow.timerange]
    ];
    fields.forEach(function (f) {
      if (f[1] == null || f[1] === '') return;
      meta.appendChild(el('dt', { text: f[0] }));
      meta.appendChild(el('dd', { class: 'mono', text: String(f[1]) }));
    });
    if (flow.tags && Object.keys(flow.tags).length) {
      meta.appendChild(el('dt', { text: 'Tags' }));
      meta.appendChild(
        el('dd', { class: 'mono', text: JSON.stringify(flow.tags) })
      );
    }
    mount(el('section', { class: 'panel' }, [meta]));
  }

  // mode: 'live' serves the live edge (?type=live); 'window' serves a single
  // 10-minute window (?timerange=...) selected via the navigator, never the
  // whole-recording VOD playlist. The clock parses whichever (small) playlist
  // it gets, so it works for both.
  function renderPlayer(flow, mode, windowStartSec) {
    var m3u8 = 'flows/' + encodeURIComponent(flow.id) + '/output.m3u8';
    var query =
      mode === 'live'
        ? 'type=live'
        : windowStartSec != null
          ? windowTimerangeQuery(windowStartSec)
          : 'type=live'; // no segments => fall back to a harmless live probe
    var absoluteM3u8 = new URL(m3u8 + '?' + query, API_BASE).href;

    var wrap = el('section', { class: 'player-wrap' });

    // Window/Live toggle -> real <a href>. "Window" returns to the latest
    // 10-minute window (no &start, the router defaults to latest); "Live"
    // serves the live edge.
    var base = '?flow=' + encodeURIComponent(flow.id);
    var toggle = el('div', { class: 'toggle', role: 'group' }, [
      el('a', {
        href: base,
        text: 'Window',
        'aria-current': mode === 'live' ? 'false' : 'true'
      }),
      el('a', {
        href: base + '&type=live',
        text: 'Live',
        'aria-current': mode === 'live' ? 'true' : 'false'
      })
    ]);

    var copyBtn = el('button', {
      class: 'copy',
      type: 'button',
      text: 'Copy m3u8 URL'
    });
    copyBtn.addEventListener('click', function () {
      var done = function () {
        copyBtn.textContent = 'Copied';
        setTimeout(function () {
          copyBtn.textContent = 'Copy m3u8 URL';
        }, 1500);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(absoluteM3u8).then(done, function () {
          window.prompt('Copy this URL into Omakase:', absoluteM3u8);
        });
      } else {
        window.prompt('Copy this URL into Omakase:', absoluteM3u8);
      }
    });

    // Build the <video> first so the transport can drive it. Muted is required
    // for reliable autostart: browsers block UNMUTED autoplay without a user
    // gesture, which left live sitting paused at the window start (the playhead
    // then drifts "minutes behind" the edge and the player looks frozen while
    // hls.js keeps doing its normal live manifest reloads, read as "hammering").
    // The live mux flow is video-only (no audio track), so muting costs nothing;
    // native controls still expose unmute for flows that do carry audio.
    var video = el('video', {
      controls: '',
      playsinline: '',
      muted: '',
      autoplay: ''
    });
    video.muted = true;

    // Prominent "watching" wall-clock readout (local time + how far behind).
    var clock = el('span', {
      class: 'clock',
      title:
        'Local time at the current playhead, and how far behind wall-clock it is',
      text: '--:--:--'
    });

    // The furthest seekable position: duration for VOD, the seekable end for an
    // open live DVR window.
    function seekMax() {
      return seekEnd(video);
    }
    function seekTo(t) {
      var max = seekMax();
      var clamped = Math.max(0, max > 0 ? Math.min(max, t) : t);
      try {
        video.currentTime = clamped;
      } catch (e) {
        /* not seekable yet */
      }
    }

    // Draggable seek bar across the whole available timeline.
    var seekbar = el('input', {
      type: 'range',
      class: 'seekbar',
      min: '0',
      max: '0',
      value: '0',
      step: '0.1',
      'aria-label': 'Seek'
    });
    var scrub = { active: false };
    seekbar.addEventListener('input', function () {
      scrub.active = true;
      seekTo(Number(seekbar.value));
    });
    seekbar.addEventListener('change', function () {
      scrub.active = false;
    });
    // Keep the bar in sync with playback (skip while the user is dragging).
    playerTimers.push(
      setInterval(function () {
        var max = seekMax();
        if (max > 0) seekbar.max = String(max);
        if (!scrub.active) seekbar.value = String(video.currentTime || 0);
      }, 250)
    );

    // Several jump sizes plus a jump to the latest available position.
    function jumpBtn(label, delta) {
      var b = el('button', { class: 'copy', type: 'button', text: label });
      b.addEventListener('click', function () {
        seekTo(video.currentTime + delta);
      });
      return b;
    }
    var liveBtn = el('button', {
      class: 'copy',
      type: 'button',
      text: '» Live',
      title: 'Jump to the latest available position'
    });
    liveBtn.addEventListener('click', function () {
      var m = seekMax();
      if (m > 0) seekTo(m);
    });
    var live30Btn = el('button', {
      class: 'copy',
      type: 'button',
      text: '» Live -30s',
      title: 'Jump to 30 seconds before the latest available position'
    });
    live30Btn.addEventListener('click', function () {
      var m = seekMax();
      if (m > 0) seekTo(m - 30);
    });

    wrap.appendChild(
      el('div', { class: 'player-controls' }, [toggle, copyBtn])
    );
    wrap.appendChild(video);
    wrap.appendChild(el('div', { class: 'watching' }, [clock]));
    wrap.appendChild(seekbar);
    wrap.appendChild(
      el('div', { class: 'player-controls' }, [
        jumpBtn('-60s', -60),
        jumpBtn('-30s', -30),
        jumpBtn('-10s', -10),
        jumpBtn('+10s', 10),
        jumpBtn('+30s', 30),
        jumpBtn('+60s', 60),
        live30Btn,
        liveBtn
      ])
    );

    var playStatus = el('p', {
      class: 'status',
      role: 'status',
      'aria-live': 'polite'
    });
    wrap.appendChild(playStatus);
    mount(wrap);

    attachPlayer(video, absoluteM3u8, mode, playStatus, clock);

    // Empty-window note: a 10-minute window with no segments still yields a
    // valid (empty) playlist, so the player simply shows nothing. Surface a
    // short note so the empty state is not mistaken for a load failure.
    if (mode !== 'live') {
      fetch(absoluteM3u8, { method: 'GET' })
        .then(function (r) {
          return r.ok ? r.text() : '';
        })
        .then(function (text) {
          if (text.indexOf('#EXTINF:') === -1) {
            wrap.appendChild(
              notice('empty', 'No segments in this 10-minute window.')
            );
          }
        })
        .catch(function () {});
    }
  }

  // Lazy-load the vendored hls.js only here (ADR-007 D2). We PREFER hls.js
  // whenever it is supported and fall back to the browser's native HLS only when
  // it is not (e.g. iOS Safari, which has no MSE). Native is the fallback, not
  // the default: a browser's built-in HLS client re-polls our live playlist many
  // times per second, while hls.js reloads it about once per target-duration.
  function attachPlayer(video, src, mode, playStatus, clock) {
    function fail(msg) {
      playStatus.textContent = msg;
    }

    // Parse the playlist ourselves: hls.js does not reliably expose per-fragment
    // PROGRAM-DATE-TIME here, so map the playhead to wall-clock straight from the
    // m3u8. segTimes[i] = { pdtMs, mediaStart, dur } where mediaStart is the
    // cumulative media-time (sum of EXTINF). Gap-immune: each segment carries its
    // own real wall-clock, so a producer-off gap does not accumulate drift the way
    // first-segment-PDT + currentTime did.
    var segTimes = null;
    fetch(src, { method: 'GET' })
      .then(function (r) {
        return r.ok ? r.text() : '';
      })
      .then(function (text) {
        var lines = text.split('\n');
        var arr = [];
        var cum = 0;
        var pdt = null;
        for (var i = 0; i < lines.length; i++) {
          var ln = lines[i].trim();
          if (ln.indexOf('#EXT-X-PROGRAM-DATE-TIME:') === 0) {
            var t = Date.parse(ln.slice(25));
            pdt = isNaN(t) ? null : t;
          } else if (ln.indexOf('#EXTINF:') === 0) {
            var dur = parseFloat(ln.slice(8)) || 0;
            arr.push({ pdtMs: pdt, mediaStart: cum, dur: dur });
            cum += dur;
            pdt = null;
          }
        }
        if (arr.length) segTimes = arr;
      })
      .catch(function () {});

    // Playhead wall-clock from the parsed playlist: find the segment covering the
    // current media-time and use ITS PROGRAM-DATE-TIME + the offset within it.
    function playheadFromParse() {
      if (!segTimes) return null;
      var ct = video.currentTime || 0;
      for (var i = segTimes.length - 1; i >= 0; i--) {
        if (ct >= segTimes[i].mediaStart && segTimes[i].pdtMs != null) {
          return new Date(
            segTimes[i].pdtMs + (ct - segTimes[i].mediaStart) * 1000
          );
        }
      }
      return segTimes[0].pdtMs != null
        ? new Date(segTimes[0].pdtMs + ct * 1000)
        : null;
    }

    // Tick the wall-clock readout on a timer (independent of "timeupdate", so it
    // reflects seeks immediately). getDate() returns the playhead's program time
    // (PROGRAM-DATE-TIME) for the segment ON SCREEN, or null. The manifest now
    // emits PDT in civil UTC (the gateway subtracts the TAI offset), so we render
    // it directly. The raw-ns paths (segment table, navigator) still convert TAI
    // with TAI_UTC_OFFSET_MS; only the manifest-PDT clock changed. Show "—" until
    // the playhead time is known rather than ever displaying a guessed value.
    function isValidDate(d) {
      return d && typeof d.getTime === 'function' && !isNaN(d.getTime());
    }
    function wireClock(getDate) {
      if (!clock) return;
      playerTimers.push(
        setInterval(function () {
          var d = getDate();
          if (!isValidDate(d)) {
            clock.textContent = '—';
            return;
          }
          var civil = d;
          clock.textContent =
            civil.toLocaleTimeString() +
            '  ·  ' +
            behindLabel(Date.now() - civil.getTime());
        }, 500)
      );
    }

    // Native HLS playback, used ONLY as a fallback when hls.js cannot run.
    // getStartDate() is the EXT-X-PROGRAM-DATE-TIME of the playlist start; the
    // playhead clock is that plus currentTime.
    function playNative() {
      video.src = src;
      playStatus.textContent = 'Native HLS playback.';
      // Visible disclaimer: native HLS is the browser's own client, which we do
      // not control. It can misbehave on live (e.g. re-polling the manifest many
      // times per second). hls.js is preferred; this is a best-effort fallback.
      if (video.parentNode) {
        video.parentNode.appendChild(
          notice(
            'cant-play',
            'Your browser is using its built-in HLS player (the hls.js engine ' +
              'is not available here). Playback is best-effort and not ' +
              'guaranteed; live streams in particular may behave incorrectly.'
          )
        );
      }
      wireClock(function () {
        var d = playheadFromParse();
        if (d) return d;
        var start = video.getStartDate ? video.getStartDate() : null;
        if (!start || isNaN(start.getTime())) return null;
        return new Date(start.getTime() + video.currentTime * 1000);
      });
    }

    var canNative = !!video.canPlayType('application/vnd.apple.mpegurl');

    playStatus.innerHTML =
      '<span class="spinner" aria-hidden="true"></span>Loading player…';

    var script = document.createElement('script');
    script.src = '/ui/vendor/hls.min.js';
    script.onload = function () {
      var Hls = window.Hls;
      if (!Hls || !Hls.isSupported()) {
        // hls.js unsupported (e.g. iOS Safari, no MSE): fall back to native HLS.
        if (canNative) {
          playNative();
        } else {
          fail('This browser cannot play HLS.');
        }
        return;
      }
      // lowLatencyMode MUST be set false explicitly: hls.js defaults it to TRUE
      // (https://github.com/video-dev/hls.js/blob/master/docs/API.md). Our live
      // playlist is plain HLS (no EXT-X-PART / SERVER-CONTROL / PART-HOLD-BACK),
      // so with LL mode on hls.js polls the media playlist for parts that never
      // arrive and reloads it many times per target-duration (observed ~7 req/s,
      // ~126ms apart, all 200) instead of about once per segment. Turning it off
      // restores the standard targetduration-paced reload. hls.js still detects
      // live vs VOD from the absence of EXT-X-ENDLIST. backBufferLength keeps the
      // live DVR window buffered so -10s jumps have data to seek to.
      // ?debug=1 in the URL turns on hls.js verbose logging (and exposes the
      // instance as window.__hls) so the live player's reload behaviour can be
      // inspected in the console without a rebuild.
      var hlsDebug =
        new URLSearchParams(window.location.search).get('debug') === '1';
      var hls = new Hls({
        debug: hlsDebug,
        lowLatencyMode: false,
        backBufferLength: 300,
        // Bound live-playlist reload retries so a transient backend error (e.g.
        // a 503 from the metadata store on a ?type=live reload) backs off
        // instead of becoming a request storm. Without an explicit policy a
        // sustained error turns the live reload into a tight retry loop.
        playlistLoadPolicy: {
          default: {
            maxTimeToFirstByteMs: 10000,
            maxLoadTimeMs: 20000,
            timeoutRetry: {
              maxNumRetry: 2,
              retryDelayMs: 0,
              maxRetryDelayMs: 0
            },
            errorRetry: {
              maxNumRetry: 4,
              retryDelayMs: 1000,
              maxRetryDelayMs: 8000,
              backoff: 'exponential'
            }
          }
        }
      });
      currentHls = hls;
      if (hlsDebug) window.__hls = hls;
      // Playhead wall-clock. Track the fragment ACTUALLY ON SCREEN (FRAG_CHANGED)
      // and use ITS own PROGRAM-DATE-TIME plus only the offset WITHIN that segment.
      // This is immune to discontinuities: across a producer-off gap, media
      // currentTime does not advance but wall-clock does, so first-segment-PDT +
      // currentTime drifts behind by the total gap length (the old bug). Each
      // segment's own programDateTime already carries the correct wall-clock.
      var playingFrag = null;
      // Bounded recovery budget for fatal network errors (see the ERROR handler).
      var netBackoffMs = 0;
      var netRetries = 0;
      var MAX_NET_RETRIES = 3;
      hls.on(Hls.Events.FRAG_CHANGED, function (_e, data) {
        playingFrag = data && data.frag ? data.frag : null;
        // A fragment played: the stream recovered, so reset the error backoff
        // budget for any future transient failure.
        netRetries = 0;
        netBackoffMs = 0;
      });
      wireClock(function () {
        var d = playheadFromParse();
        if (d) return d;
        if (playingFrag && playingFrag.programDateTime != null) {
          return new Date(
            playingFrag.programDateTime +
              (video.currentTime - playingFrag.start) * 1000
          );
        }
        if (hls.playingDate) return hls.playingDate;
        return null;
      });
      // Stop refreshing the live manifest while the player is paused. A live
      // playlist reloads every target-duration; when autoplay is blocked (a
      // browser policy we cannot override from JS) the player sits paused and
      // those steady 2s reloads look like "hammering" with no playback. stopLoad
      // halts the refresh + fragment loop while paused; startLoad resumes it, and
      // for live we snap back near the edge so resuming does not replay stale
      // buffer minutes behind. VOD has no manifest refresh, so this only quiets
      // the live case and is harmless for windows.
      var isLiveMode = mode === 'live';
      function seekLiveEdge() {
        if (!isLiveMode) return;
        var s = video.seekable;
        if (s && s.length) {
          var end = s.end(s.length - 1);
          if (end - video.currentTime > 12) {
            video.currentTime = Math.max(0, end - 6);
          }
        }
      }
      video.addEventListener('pause', function () {
        if (!video.ended) hls.stopLoad();
      });
      video.addEventListener('play', function () {
        hls.startLoad();
        setTimeout(seekLiveEdge, 400);
      });
      hls.on(Hls.Events.MANIFEST_PARSED, function () {
        playStatus.textContent = '';
        // Best-effort muted autostart. If the browser blocks it, stop the load
        // loop so a paused player does not keep refreshing the live manifest;
        // pressing play resumes it (startLoad) and snaps to the live edge.
        var p = video.play();
        if (p && p.catch)
          p.catch(function () {
            hls.stopLoad();
            playStatus.textContent = 'Press play to start playback.';
          });
      });
      // Non-fatal errors (e.g. a single failed live-manifest reload) are handled
      // by the playlistLoadPolicy backoff above. Only act on fatal errors here,
      // and always stop the load loop first so hls.js does not keep retrying in
      // the background: the old handler set a message but left the loop running,
      // which under a sustained backend error read as request "hammering".
      hls.on(Hls.Events.ERROR, function (_evt, data) {
        if (!data || !data.fatal) return;
        try {
          hls.stopLoad();
        } catch (e) {
          /* already stopped */
        }
        if (
          data.type === Hls.ErrorTypes.NETWORK_ERROR &&
          netRetries < MAX_NET_RETRIES
        ) {
          // One bounded, backed-off recovery attempt instead of a tight loop.
          netRetries++;
          netBackoffMs = Math.min(
            netBackoffMs ? netBackoffMs * 2 : 2000,
            30000
          );
          fail(
            'Stream temporarily unavailable. Retrying in ' +
              Math.round(netBackoffMs / 1000) +
              's… (' +
              netRetries +
              '/' +
              MAX_NET_RETRIES +
              ')'
          );
          setTimeout(function () {
            try {
              hls.startLoad();
            } catch (e) {
              /* destroyed */
            }
          }, netBackoffMs);
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          hls.recoverMediaError();
        } else {
          fail(
            'Playback error (' +
              (data.type || 'unknown') +
              '). Segment URLs presign with a TTL and the MinIO bucket needs a ' +
              'CORS policy allowing GET + Range from this origin.'
          );
        }
      });
      hls.loadSource(src);
      hls.attachMedia(video);
    };
    script.onerror = function () {
      // Could not load hls.js: fall back to native HLS if the browser has it.
      if (canNative) {
        playNative();
      } else {
        fail('Could not load the bundled HLS player.');
      }
    };
    document.body.appendChild(script);
  }

  function renderSegments(flowId) {
    var PAGE = 1000; // matches the API's default segment limit
    var section = el('section', { class: 'panel' }, [
      el('h2', { text: 'Segments' }),
      el('p', {
        class: 'status',
        role: 'status',
        'aria-live': 'polite',
        id: 'seg-status',
        html: '<span class="spinner" aria-hidden="true"></span>Loading segments…'
      })
    ]);
    mount(section);

    var tbody = el('tbody', null, []);
    var caption = el('caption', { text: '' });
    var table = el('table', null, [
      caption,
      el('thead', null, [
        el('tr', null, [
          el('th', { scope: 'col', text: '#' }),
          el('th', { scope: 'col', text: 'Local time (start)' }),
          el('th', { scope: 'col', text: 'Timerange (TAI)' }),
          el('th', { scope: 'col', text: 'Duration' }),
          el('th', { scope: 'col', text: 'Object' })
        ])
      ]),
      tbody
    ]);

    var total = 0;
    var discontinuities = 0;
    var prevEnd = null; // ns end of the previous row, for discontinuity detection
    var lastEnd = null; // ns end of the last loaded segment, for the next-page cursor
    var moreBtn = el('button', {
      class: 'copy',
      type: 'button',
      text: 'Load more'
    });

    function appendRows(segments) {
      segments.forEach(function (seg) {
        var range = parseSegmentRange(seg.timerange);
        if (prevEnd != null && range != null && range.start !== prevEnd) {
          discontinuities++;
          tbody.appendChild(
            el('tr', { class: 'disc-row' }, [
              el('td', { colspan: '5' }, [
                el('span', { class: 'disc-tag', text: 'discontinuity' })
              ])
            ])
          );
        }
        var dur = durationSeconds(range);
        tbody.appendChild(
          el('tr', null, [
            el('td', { class: 'mono', text: String(total) }),
            el('td', { text: range ? nsToLocal(range.start) : '-' }),
            el('td', { class: 'mono', text: seg.timerange }),
            el('td', {
              class: 'mono',
              text: dur == null ? '-' : dur.toFixed(3) + ' s'
            }),
            el('td', { class: 'mono', text: seg.object_id })
          ])
        );
        if (range) {
          prevEnd = range.end;
          lastEnd = range.end;
        }
        total++;
      });
      caption.textContent =
        total +
        ' segments loaded' +
        (discontinuities
          ? ', ' +
            discontinuities +
            ' discontinuit' +
            (discontinuities === 1 ? 'y' : 'ies')
          : '');
    }

    // Page through segments with a ts_start cursor so flows with more than the
    // API's per-request limit are fully browsable (ADR-007 item 2).
    function loadPage(cursorNs) {
      var path = 'flows/' + encodeURIComponent(flowId) + '/segments';
      if (cursorNs != null) {
        path +=
          '?timerange=' + encodeURIComponent('[' + nsToTai(cursorNs) + '_)');
      }
      moreBtn.disabled = true;
      return getJson(path).then(function (segments) {
        // Guard against re-including the boundary segment from the cursor query.
        if (cursorNs != null && segments.length) {
          segments = segments.filter(function (s) {
            var r = parseSegmentRange(s.timerange);
            return !r || r.start >= cursorNs;
          });
        }
        appendRows(segments);
        moreBtn.disabled = false;
        return segments.length >= PAGE; // a full page means there may be more
      });
    }

    loadPage(null)
      .then(function (maybeMore) {
        var segStatus = section.querySelector('#seg-status');
        if (segStatus) segStatus.remove();
        if (total === 0) {
          section.appendChild(
            notice('empty', 'No segments stored for this flow yet.')
          );
          return;
        }
        section.appendChild(table);
        if (maybeMore) {
          moreBtn.addEventListener('click', function () {
            loadPage(lastEnd).then(function (more) {
              if (!more) moreBtn.remove();
            });
          });
          section.appendChild(moreBtn);
        }
      })
      .catch(function (err) {
        var segStatus = section.querySelector('#seg-status');
        if (segStatus) segStatus.remove();
        section.appendChild(
          notice(
            'error',
            'Could not load segments (' + describeError(err) + ').'
          )
        );
      });
  }

  // --- error rendering ------------------------------------------------------

  function describeError(err) {
    if (err && err.status === 404) return 'not found';
    if (err && err.status === 415) return 'unsupported media type';
    if (err && err.status) return 'HTTP ' + err.status;
    return 'network error';
  }

  function renderError(err, what) {
    clearView();
    setStatus('');
    if (err && err.status === 404) {
      viewEl.appendChild(
        notice('error', 'The requested ' + what + ' was not found (404).')
      );
      viewEl.appendChild(
        el('p', null, [el('a', { href: '?', text: '← Back to flows' })])
      );
      return;
    }
    viewEl.appendChild(
      notice(
        'error',
        'Could not load ' +
          what +
          ' (' +
          describeError(err) +
          '). The gateway ' +
          'may be unreachable or require authentication.'
      )
    );
  }

  // ==========================================================================
  // Router (reads location.search; navigation is via real <a href> links)
  // ==========================================================================

  function route() {
    var params = new URLSearchParams(window.location.search);
    var flow = params.get('flow');
    var source = params.get('source');
    var tab = params.get('tab');

    if (flow) {
      markActiveTab('flows');
      renderFlowDetail(flow, params.get('type'), params.get('start'));
    } else if (source) {
      renderFlowsList(source);
    } else if (tab === 'sources') {
      renderSourcesList();
    } else {
      renderFlowsList(null);
    }
  }

  route();
})();
