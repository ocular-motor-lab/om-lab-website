/* plotspec.js — render a library-agnostic plot spec (see runner._build_plot_spec)
 * as a stack of zoomable, cursor-synced uPlot panels.
 *
 *   PlotSpec.render(containerEl, spec)  ->  { destroy() }
 *
 * Spec shape (per panel):
 *   { name, ylabel, ylabel_right?, ymin_span?, type: "lines"|"gantt",
 *     hlines: [{y, color, style, label?}], shading: [[t0,t1], ...],
 *     traces: [{label, color, style, axis: "left"|"right", y: [...]}],
 *     lanes:  [...]   // type == "gantt" only
 *   }
 *
 * Zoom: drag-select on any panel zooms the shared time axis on every panel;
 * double-click resets. Hover shows a synced crosshair + per-series values.
 *
 * Requires uPlot (window.uPlot) loaded first.
 */
(function () {
  'use strict';

  const SYNC_KEY = 'plotspec-x';

  // matplotlib linestyle -> uPlot dash array (CSS px)
  function dash(style) {
    switch (style) {
      case '--': return [6, 4];
      case '-.': return [8, 4, 2, 4];
      case ':':  return [2, 4];
      default:   return [];          // solid
    }
  }

  function injectStyles() {
    if (document.getElementById('plotspec-styles')) return;
    const css = `
      .ps-panel { margin-bottom: 6px; }
      .ps-panel .u-legend { font-size: 10px; padding: 2px 0 4px; }
      .ps-panel .u-legend .u-marker { width: 10px; height: 10px; }
      .ps-ylabel { font-size: 10px; color: #64748b; letter-spacing: .03em;
                   margin: 2px 0 0 6px; text-transform: none; }
      .ps-hint { font-size: 10px; color: #94a3b8; margin: 0 0 8px 6px; }
      .ps-playhead { position: absolute; top: 0; bottom: 0; width: 0;
                     border-left: 1.5px solid #ef4444; pointer-events: none;
                     display: none; z-index: 5; }
      /* title + legend share one row to keep the plot area tall */
      .ps-head { display: flex; align-items: baseline; justify-content: space-between;
                 gap: 12px; margin: 2px 6px 0; flex-wrap: wrap; }
      .ps-head .ps-ylabel { margin: 0; }
      .ps-legend { display: flex; flex-wrap: wrap; gap: 2px 12px; align-items: center; }
      .ps-leg-item { display: inline-flex; align-items: center; gap: 5px;
                     font-size: 10px; color: #475569; white-space: nowrap; }
      .ps-swatch { width: 14px; height: 2px; border-radius: 1px;
                   display: inline-block; flex-shrink: 0; }
      /* gantt */
      .ps-gantt-lane { display: flex; align-items: center; height: 24px; margin: 2px 0; }
      .ps-gantt-label { width: 96px; flex-shrink: 0; font-size: 10px; color: #64748b;
                        text-align: right; padding-right: 8px; }
      .ps-gantt-track { position: relative; flex: 1; height: 20px;
                        background: #eef0f4; border-radius: 3px; overflow: hidden; }
      .ps-gantt-seg { position: absolute; top: 0; height: 100%; display: flex;
                      align-items: center; justify-content: center; font-size: 9px;
                      color: #1c2230; white-space: nowrap; overflow: hidden; }
      .ps-gantt-seg.off { background-image: repeating-linear-gradient(
                            45deg, #dfe3ea 0, #dfe3ea 4px, #eef0f4 4px, #eef0f4 8px);
                          color: #94a3b8; }
    `;
    const el = document.createElement('style');
    el.id = 'plotspec-styles';
    el.textContent = css;
    document.head.appendChild(el);
  }

  // Plugin: dark-period shading + horizontal reference lines, drawn behind series.
  function annotationsPlugin(panel) {
    return {
      hooks: {
        drawClear: (u) => {
          const ctx = u.ctx;
          // shaded dark spans (x in data units)
          (panel.shading || []).forEach(([t0, t1]) => {
            const x0 = u.valToPos(t0, 'x', true);
            const x1 = u.valToPos(t1, 'x', true);
            ctx.save();
            ctx.fillStyle = 'rgba(120,120,140,0.10)';
            ctx.fillRect(x0, u.bbox.top, x1 - x0, u.bbox.height);
            ctx.restore();
          });
        },
        draw: (u) => {
          const ctx = u.ctx;
          (panel.hlines || []).forEach((h) => {
            if (u.scales.y.min == null) return;
            const y = u.valToPos(h.y, 'y', true);
            ctx.save();
            ctx.strokeStyle = h.color || '#888';
            ctx.lineWidth = Math.max(1, Math.round(devicePixelRatio));
            ctx.setLineDash(dash(h.style).map((d) => d * devicePixelRatio));
            ctx.beginPath();
            ctx.moveTo(u.bbox.left, y);
            ctx.lineTo(u.bbox.left + u.bbox.width, y);
            ctx.stroke();
            ctx.restore();
          });
        },
      },
    };
  }

  function makeLinePanel(panel, t, sharedX, registerChart) {
    const wrap = document.createElement('div');
    wrap.className = 'ps-panel';

    const hasRight = (panel.traces || []).some((tr) => tr.axis === 'right');

    const series = [{ label: 'time (s)' }];
    const data = [t];
    (panel.traces || []).forEach((tr) => {
      series.push({
        label: tr.label,
        stroke: tr.color,
        width: 1.3,
        dash: dash(tr.style),
        scale: tr.axis === 'right' ? 'y2' : 'y',
        spanGaps: false,
        points: { show: false },
      });
      data.push(tr.y);
    });

    const yRange = (u, dMin, dMax) => {
      let [min, max] = uPlot.rangeNum(dMin, dMax, 0.1, true);
      if (panel.ymin_span && (max - min) < panel.ymin_span) {
        const mid = (min + max) / 2;
        min = mid - panel.ymin_span / 2;
        max = mid + panel.ymin_span / 2;
      }
      return [min, max];
    };

    const axes = [
      { stroke: '#475569', grid: { stroke: '#e5e7eb', width: 1 },
        ticks: { stroke: '#d3d7e0' }, font: '10px sans-serif' },
      { scale: 'y', stroke: '#475569', grid: { stroke: '#e5e7eb', width: 1 },
        ticks: { stroke: '#d3d7e0' }, font: '10px sans-serif', size: 52 },
    ];
    const scales = { x: { time: false }, y: { range: yRange } };
    if (hasRight) {
      scales.y2 = { range: (u, a, b) => uPlot.rangeNum(a, b, 0.1, true) };
      axes.push({ scale: 'y2', side: 1, stroke: '#64748b', grid: { show: false },
                  ticks: { stroke: '#d3d7e0' }, font: '10px sans-serif', size: 46 });
    }

    let syncingLocal = false;
    const opts = {
      width: wrap.clientWidth || 600,
      height: 180,
      pxAlign: false,                  // don't snap thin diagonals to the pixel grid → smoother lines
      scales,
      series,
      axes,
      legend: { show: false },         // custom inline legend shares the title row
      cursor: {
        sync: { key: SYNC_KEY },
        drag: { x: true, y: false },
        // NB: do NOT set points.show = true here — uPlot wraps a boolean via
        // fnOrSelf and then calls addClass(true, …), throwing on .classList.
      },
      plugins: [annotationsPlugin(panel)],
      hooks: {
        setScale: [
          (u, key) => {
            if (key !== 'x' || syncingLocal) return;
            syncingLocal = true;
            registerChart.syncX(u, u.scales.x.min, u.scales.x.max);
            syncingLocal = false;
            registerChart.reposition();          // keep playhead glued on zoom
          },
        ],
      },
    };

    // Header: y-axis label (left) + compact legend (right) on one row, so the
    // canvas keeps its full height instead of losing it to a legend below.
    const head = document.createElement('div');
    head.className = 'ps-head';
    const label = document.createElement('span');
    label.className = 'ps-ylabel';
    label.textContent = panel.ylabel;
    head.appendChild(label);

    const legend = document.createElement('span');
    legend.className = 'ps-legend';
    (panel.traces || []).forEach((tr) => {
      const item = document.createElement('span');
      item.className = 'ps-leg-item';
      const sw = document.createElement('span');
      sw.className = 'ps-swatch';
      const d = dash(tr.style);
      if (d.length) {
        // Dashed/dotted swatch matching the line style (horizontal dashes).
        const on = d[0], off = d[1] || d[0];
        sw.style.background =
          `repeating-linear-gradient(90deg, ${tr.color} 0 ${on}px, transparent ${on}px ${on + off}px)`;
      } else {
        sw.style.background = tr.color;
      }
      item.appendChild(sw);
      item.appendChild(document.createTextNode(
        tr.label + (tr.axis === 'right' ? ' (R)' : '')));
      legend.appendChild(item);
    });
    head.appendChild(legend);
    wrap.appendChild(head);

    const u = new uPlot(opts, data, wrap);
    registerChart.add(u);

    // External time playhead (synced to 3D playback): a positioned line over the
    // plot area, moved via the render handle's setTime() — no canvas redraw.
    const ph = document.createElement('div');
    ph.className = 'ps-playhead';
    u.over.appendChild(ph);
    registerChart.addPlayhead(u, ph);

    return wrap;
  }

  function makeGanttPanel(panel, tmin, tmax, registry) {
    const wrap = document.createElement('div');
    wrap.className = 'ps-panel';
    const label = document.createElement('div');
    label.className = 'ps-ylabel';
    label.textContent = panel.ylabel || 'Visual context';
    wrap.appendChild(label);

    const span = (tmax - tmin) || 1;
    (panel.lanes || []).forEach((lane) => {
      const row = document.createElement('div');
      row.className = 'ps-gantt-lane';
      const lab = document.createElement('div');
      lab.className = 'ps-gantt-label';
      lab.textContent = lane.label;
      const track = document.createElement('div');
      track.className = 'ps-gantt-track';
      (lane.segments || []).forEach(([s0, s1, state]) => {
        const seg = document.createElement('div');
        seg.className = 'ps-gantt-seg' + (state ? '' : ' off');
        seg.style.left = (100 * (s0 - tmin) / span) + '%';
        seg.style.width = (100 * (s1 - s0) / span) + '%';
        if (state) seg.style.background = lane.color_on;
        const w = (s1 - s0) / span;
        if (w > 0.04) seg.textContent = state ? lane.on_label : lane.off_label;
        track.appendChild(seg);
      });
      // Time cursor for this lane. The gantt uses a fixed full-time scale (it
      // never zooms), so position is a simple fraction of [tmin, tmax].
      const ph = document.createElement('div');
      ph.className = 'ps-playhead';
      track.appendChild(ph);
      registry.addGanttPlayhead(ph, tmin, tmax);
      row.appendChild(lab);
      row.appendChild(track);
      wrap.appendChild(row);
    });
    return wrap;
  }

  function render(container, spec) {
    injectStyles();
    container.innerHTML = '';

    const charts = [];
    const playheads = [];        // uPlot panels: [{ u, ph }]
    const ganttPlayheads = [];   // gantt lanes: [{ ph, tmin, tmax }] (fixed scale)
    let playT = null;            // current playhead time (s), or null = hidden
    let syncingGlobal = false;
    const registry = {
      add: (u) => charts.push(u),
      addPlayhead: (u, ph) => playheads.push({ u, ph }),
      addGanttPlayhead: (ph, a, b) => ganttPlayheads.push({ ph, tmin: a, tmax: b }),
      reposition: () => {
        for (const { u, ph } of playheads) {
          if (playT == null) { ph.style.display = 'none'; continue; }
          const x = u.valToPos(playT, 'x');
          const w = u.over.clientWidth;
          // 1px tolerance + clamp so a cursor sitting exactly on a panned edge
          // is still drawn (never flickers off) rather than hidden.
          if (x < -1 || x > w + 1) { ph.style.display = 'none'; }
          else {
            ph.style.left = Math.max(0, Math.min(w, x)) + 'px';
            ph.style.display = 'block';
          }
        }
        // Gantt lanes: fixed full-time scale, so a simple clamped fraction.
        for (const { ph, tmin, tmax } of ganttPlayheads) {
          if (playT == null) { ph.style.display = 'none'; continue; }
          const frac = (playT - tmin) / ((tmax - tmin) || 1);
          ph.style.left = (Math.max(0, Math.min(1, frac)) * 100) + '%';
          ph.style.display = 'block';
        }
      },
      setPlayT: (t) => {
        playT = t;
        // When zoomed in time, pan the shared window so the cursor stays visible.
        const c0 = charts[0];
        if (c0 && c0.scales.x.min != null) {
          let min = c0.scales.x.min, max = c0.scales.x.max;
          const width = max - min;
          const zoomed = width < (tmax - tmin) - 1e-9;
          if (zoomed && (t < min || t > max)) {
            if (t < min) { min = t; max = t + width; }
            else         { min = t - width; max = t; }
            if (min < tmin) { min = tmin; max = tmin + width; }
            if (max > tmax) { max = tmax; min = tmax - width; }
            c0.setScale('x', { min, max });   // hook syncs siblings + repositions
            return;
          }
        }
        registry.reposition();
      },
      syncX: (src, min, max) => {
        if (syncingGlobal) return;
        syncingGlobal = true;
        for (const c of charts) {
          if (c === src) continue;
          if (c.scales.x.min !== min || c.scales.x.max !== max) {
            c.setScale('x', { min, max });
          }
        }
        syncingGlobal = false;
      },
    };

    const t = spec.t || [];
    const tmin = t.length ? t[0] : 0;
    const tmax = t.length ? t[t.length - 1] : 1;

    (spec.panels || []).forEach((panel) => {
      try {
        const el = (panel.type === 'gantt')
          ? makeGanttPanel(panel, tmin, tmax, registry)
          : makeLinePanel(panel, t, [tmin, tmax], registry);
        container.appendChild(el);
      } catch (e) {
        console.error('plotspec: failed to render panel', panel && panel.name, e);
        const err = document.createElement('div');
        err.className = 'ps-ylabel';
        err.textContent = `(panel "${panel && panel.name}" could not be drawn)`;
        container.appendChild(err);
      }
    });

    const hint = document.createElement('div');
    hint.className = 'ps-hint';
    hint.textContent = 'drag to zoom · double-click to reset · hover for values';
    container.appendChild(hint);

    // Responsive width
    const onResize = () => {
      charts.forEach((u) => u.setSize({ width: u.root.parentElement.clientWidth, height: 180 }));
      registry.reposition();
    };
    window.addEventListener('resize', onResize);
    onResize();

    return {
      // Move the synced time cursor across all panels (t in seconds, null hides).
      setTime: (t) => registry.setPlayT(t),
      destroy() {
        window.removeEventListener('resize', onResize);
        charts.forEach((u) => u.destroy());
        container.innerHTML = '';
      },
    };
  }

  window.PlotSpec = { render };
})();
