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

    wrap.appendChild(
      el('div', { class: 'player-controls' }, [
        toggle,
        copyBtn,
        el('span', {
          class: 'mono',
          text: mode === 'live' ? 'Live edge' : 'Full timeline'
        })
      ])
    );

    var video = el('video', { controls: '', playsinline: '' });
    wrap.appendChild(video);

    var playStatus = el('p', {
      class: 'status',
      role: 'status',
      'aria-live': 'polite'
    });
    wrap.appendChild(playStatus);
    viewEl.appendChild(wrap);

    attachPlayer(video, absoluteM3u8, mode, playStatus);
  }

  // Lazy-load the vendored hls.js only here (ADR-007 D2). Native HLS (Safari)
  // skips the library entirely.
  function attachPlayer(video, src, mode, playStatus) {
    function fail(msg) {
      playStatus.textContent = msg;
    }

    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari / native HLS.
      video.src = src;
      playStatus.textContent = 'Native HLS playback.';
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
      var hls = new Hls({ lowLatencyMode: mode === 'live' });
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

    getJson('flows/' + encodeURIComponent(flowId) + '/segments')
      .then(function (segments) {
        var segStatus = section.querySelector('#seg-status');
        if (segStatus) segStatus.remove();

        if (!segments.length) {
          section.appendChild(
            notice('empty', 'No segments stored for this flow yet.')
          );
          return;
        }

        var rows = [];
        var prevEnd = null;
        var discontinuities = 0;
        segments.forEach(function (seg, i) {
          var range = parseSegmentRange(seg.timerange);
          var gap =
            i > 0 &&
            prevEnd != null &&
            range != null &&
            range.start !== prevEnd;
          if (gap) {
            discontinuities++;
            rows.push(
              el('tr', { class: 'disc-row' }, [
                el('td', { colspan: '4' }, [
                  el('span', { class: 'disc-tag', text: 'discontinuity' })
                ])
              ])
            );
          }
          var dur = durationSeconds(range);
          rows.push(
            el('tr', null, [
              el('td', { class: 'mono', text: String(i) }),
              el('td', { class: 'mono', text: seg.timerange }),
              el('td', {
                class: 'mono',
                text: dur == null ? '-' : dur.toFixed(3) + ' s'
              }),
              el('td', { class: 'mono', text: seg.object_id })
            ])
          );
          if (range) prevEnd = range.end;
        });

        section.appendChild(
          el('table', null, [
            el('caption', {
              text:
                segments.length +
                ' segments' +
                (discontinuities
                  ? ', ' +
                    discontinuities +
                    ' discontinuit' +
                    (discontinuities === 1 ? 'y' : 'ies')
                  : '')
            }),
            el('thead', null, [
              el('tr', null, [
                el('th', { scope: 'col', text: '#' }),
                el('th', { scope: 'col', text: 'Timerange (TAI)' }),
                el('th', { scope: 'col', text: 'Duration' }),
                el('th', { scope: 'col', text: 'Object' })
              ])
            ]),
            el('tbody', null, rows)
          ])
        );
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
