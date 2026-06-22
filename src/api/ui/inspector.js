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

  var statusEl = document.getElementById('status');
  var viewEl = document.getElementById('view');

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

  function clearView() {
    viewEl.innerHTML = '';
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

  // Render a nanosecond instant as native local wall-clock time. TAMS timestamps
  // are TAI; we treat them as Unix (a ~37s offset in 2026), which is fine for
  // human orientation and matches the manifest's PROGRAM-DATE-TIME (ADR-006 D3).
  function nsToLocal(ns) {
    if (ns == null) return '-';
    var d = new Date(Number(ns / NS_PER_MS));
    return d.toLocaleString();
  }

  // Render a nanosecond instant as a TAMS "sec:ns" timestamp (for building the
  // next-page timerange cursor).
  function nsToTai(ns) {
    return String(ns / NS_PER_S) + ':' + String(ns % NS_PER_S);
  }

  // How far behind wall-clock the given instant is, as a human label, so the
  // viewer can sense how long ago the material was current. Negative/near-zero
  // (also covers the ~37s TAI-vs-UTC skew on near-live content) reads as the
  // live edge.
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

  function renderFlowDetail(flowId, type) {
    setStatus('Loading flow…');
    getJson('flows/' + encodeURIComponent(flowId))
      .then(function (flow) {
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

        renderMetaPanel(flow);

        if (isPlayable(flow)) {
          renderPlayer(flow, type);
        } else {
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
    viewEl.appendChild(el('section', { class: 'panel' }, [meta]));
  }

  function renderPlayer(flow, type) {
    var mode = type === 'live' ? 'live' : 'vod';
    var m3u8 = 'flows/' + encodeURIComponent(flow.id) + '/output.m3u8';
    var m3u8WithType = m3u8 + '?type=' + mode;
    var absoluteM3u8 = new URL(m3u8WithType, API_BASE).href;

    var wrap = el('section', { class: 'player-wrap' });

    // Live/VOD toggle -> ?type= (default VOD, one-click Live), real <a href>.
    var base = '?flow=' + encodeURIComponent(flow.id);
    var toggle = el('div', { class: 'toggle', role: 'group' }, [
      el('a', {
        href: base + '&type=vod',
        text: 'VOD',
        'aria-current': mode === 'vod' ? 'true' : 'false'
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

    // Build the <video> first so the skip buttons can drive it (item 4). The
    // native controls give the scrubber; we add quick -10s/+10s jumps and a
    // local wall-clock readout of the current playhead.
    var video = el('video', { controls: '', playsinline: '' });

    var back10 = el('button', {
      class: 'copy',
      type: 'button',
      text: '-10s',
      title: 'Jump back 10 seconds'
    });
    var fwd10 = el('button', {
      class: 'copy',
      type: 'button',
      text: '+10s',
      title: 'Jump forward 10 seconds'
    });
    back10.addEventListener('click', function () {
      video.currentTime = Math.max(0, video.currentTime - 10);
    });
    fwd10.addEventListener('click', function () {
      video.currentTime = video.currentTime + 10;
    });
    var clock = el('span', {
      class: 'mono clock',
      title:
        'Local time at the current playhead, and how far behind wall-clock it is',
      text: '--:--:--'
    });

    wrap.appendChild(
      el('div', { class: 'player-controls' }, [
        toggle,
        back10,
        fwd10,
        copyBtn,
        clock,
        el('span', {
          class: 'mono',
          text: mode === 'live' ? 'Live edge' : 'Full timeline'
        })
      ])
    );

    wrap.appendChild(video);

    var playStatus = el('p', {
      class: 'status',
      role: 'status',
      'aria-live': 'polite'
    });
    wrap.appendChild(playStatus);
    viewEl.appendChild(wrap);

    attachPlayer(video, absoluteM3u8, mode, playStatus, clock);
  }

  // Lazy-load the vendored hls.js only here (ADR-007 D2). Native HLS (Safari)
  // skips the library entirely.
  function attachPlayer(video, src, mode, playStatus, clock) {
    function fail(msg) {
      playStatus.textContent = msg;
    }

    // Update the local wall-clock readout of the current playhead on a timer, so
    // it ticks regardless of whether "timeupdate" fires and immediately reflects
    // -10s/+10s jumps. getDate() returns a Date for the playhead (or null/invalid
    // before playback starts). Navigation is a full page load, so the interval
    // does not leak across views.
    function wireClock(getDate) {
      if (!clock) return;
      setInterval(function () {
        var d = getDate();
        if (d && typeof d.getTime === 'function' && !isNaN(d.getTime())) {
          clock.textContent =
            d.toLocaleTimeString() +
            '  ·  ' +
            behindLabel(Date.now() - d.getTime());
        }
      }, 500);
    }

    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari / native HLS. getStartDate() is the EXT-X-PROGRAM-DATE-TIME of
      // the playlist start; the playhead clock is that plus currentTime.
      video.src = src;
      playStatus.textContent = 'Native HLS playback.';
      wireClock(function () {
        var start = video.getStartDate ? video.getStartDate() : null;
        if (!start || isNaN(start.getTime())) return null;
        return new Date(start.getTime() + video.currentTime * 1000);
      });
      return;
    }

    playStatus.innerHTML =
      '<span class="spinner" aria-hidden="true"></span>Loading player…';

    var script = document.createElement('script');
    script.src = '/ui/vendor/hls.min.js';
    script.onload = function () {
      var Hls = window.Hls;
      if (!Hls || !Hls.isSupported()) {
        fail('This browser cannot play HLS.');
        return;
      }
      // lowLatencyMode stays OFF (default): our live playlist is plain HLS (no
      // EXT-X-PART / SERVER-CONTROL), so LL-HLS mode would block waiting for parts
      // that never arrive (the "live won't start, no error" symptom). hls.js
      // detects live vs VOD from the absence of EXT-X-ENDLIST. backBufferLength
      // keeps the live DVR window buffered so -10s jumps have data to seek to.
      var hls = new Hls({ backBufferLength: 300 });
      // hls.playingDate is the playhead's EXT-X-PROGRAM-DATE-TIME as a Date.
      wireClock(function () {
        return hls.playingDate;
      });
      hls.on(Hls.Events.MANIFEST_PARSED, function () {
        playStatus.textContent = '';
      });
      hls.on(Hls.Events.ERROR, function (_evt, data) {
        if (data && data.fatal) {
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
      fail('Could not load the bundled HLS player.');
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
    viewEl.appendChild(section);

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
      renderFlowDetail(flow, params.get('type') || 'vod');
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
