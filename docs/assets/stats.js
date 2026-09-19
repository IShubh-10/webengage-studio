/* ============================================================================
   Webengage Studio — open stats

   Two views on one page: every creative ranked for a window, and one creative
   on its own. The window is chosen here rather than on the server, because the
   calendar is the reader's: "this month" is the month where *you* are, and
   only this browser knows which one that is. Each request carries the two ends
   of the window plus this browser's UTC offset, and the server groups the
   stored hourly buckets to match.
   ========================================================================== */

(function () {
    'use strict';

    // Marks a fetch as the studio looking at its own work, so the thumbnails on
    // this very page do not count as opens. Mirrors STATS_PREVIEW_PARAM in
    // src/config/index.js.
    var PREVIEW_PARAM = 'we_preview';

    var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
        'September', 'October', 'November', 'December'];
    var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    // The presets, and the only values `?range=` will accept.
    var PRESETS = ['today', 'last7', 'last30', 'thisMonth', 'lastMonth', 'thisYear', 'lastYear', 'custom'];

    var state = {
        range: 'last30',
        custom: { from: null, to: null },
        view: 'overview',
        asset: null,          // { type, id } when a single creative is open
        overview: null,       // the last payload, kept so a resize can redraw
        detail: null,
    };

    function $(id) {
        return document.getElementById(id);
    }

    /* ------------------------------------------------------------- windows */

    function startOfDay(date) {
        return new Date(date.getFullYear(), date.getMonth(), date.getDate());
    }

    /**
     * A preset, as two instants in this browser's own time.
     *
     * The windows that end "now" deliberately do, rather than ending at
     * midnight: a reader checking a send at lunchtime wants today's opens in
     * the total, not a window that stops last night.
     */
    function windowFor(preset) {
        var now = new Date();
        var today = startOfDay(now);
        var year = now.getFullYear();
        var month = now.getMonth();

        switch (preset) {
            case 'today':
                return { from: today, to: now, unit: 'hour' };
            case 'last7':
                return { from: new Date(today.getTime() - 6 * 86400000), to: now, unit: 'day' };
            case 'thisMonth':
                return { from: new Date(year, month, 1), to: now, unit: 'day' };
            case 'lastMonth':
                return { from: new Date(year, month - 1, 1), to: new Date(year, month, 1), unit: 'day' };
            case 'thisYear':
                return { from: new Date(year, 0, 1), to: now, unit: 'month' };
            case 'lastYear':
                return { from: new Date(year - 1, 0, 1), to: new Date(year, 0, 1), unit: 'month' };
            case 'custom':
                return customWindow();
            default:
                return { from: new Date(today.getTime() - 29 * 86400000), to: now, unit: 'day' };
        }
    }

    /**
     * The custom range. Both dates are inclusive — a reader who picks the same
     * day twice means "that day", so the end is pushed to the start of the
     * following one rather than to midnight at its beginning.
     */
    function customWindow() {
        var from = parseDateInput($('fromDate').value);
        var to = parseDateInput($('toDate').value);

        if (!from || !to) return windowFor('last30');
        if (to < from) {
            var swap = from;
            from = to;
            to = swap;
        }

        var end = new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1);
        var days = Math.round((end - from) / 86400000);

        return { from: from, to: end, unit: days <= 2 ? 'hour' : days <= 120 ? 'day' : 'month' };
    }

    function parseDateInput(value) {
        if (!value) return null;
        var parts = value.split('-');
        if (parts.length !== 3) return null;
        return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    }

    function toDateInput(date) {
        return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
    }

    function queryFor(window_) {
        return (
            'from=' + encodeURIComponent(window_.from.toISOString()) +
            '&to=' + encodeURIComponent(window_.to.toISOString()) +
            '&unit=' + window_.unit +
            // Minutes east of UTC, the way a person would say it: +330 for IST.
            // Date#getTimezoneOffset reports the opposite sign.
            '&tzOffset=' + -new Date().getTimezoneOffset()
        );
    }

    /* ---------------------------------------------------------- formatting */

    function pad(value) {
        return String(value).padStart(2, '0');
    }

    function formatCount(value) {
        if (value >= 10000) {
            return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })
                .format(value);
        }
        return Number(value || 0).toLocaleString();
    }

    /** A bucket key from the API back to a Date in this browser's own time. */
    function bucketDate(bucket, unit) {
        var date = bucket.slice(0, 10).split('-');
        var year = Number(date[0]);
        var month = Number(date[1]) - 1;

        if (unit === 'month') return new Date(year, month, 1);
        if (unit === 'day') return new Date(year, month, Number(date[2]));
        return new Date(year, month, Number(date[2]), Number(bucket.slice(11, 13)));
    }

    /** The short form, for an axis. */
    function axisLabel(bucket, unit) {
        var date = bucketDate(bucket, unit);
        if (unit === 'month') return MONTHS[date.getMonth()] + ' ' + String(date.getFullYear()).slice(2);
        if (unit === 'day') return date.getDate() + ' ' + MONTHS[date.getMonth()];
        return pad(date.getHours()) + ':00';
    }

    /** The long form, for a tooltip or a table. */
    function fullLabel(bucket, unit) {
        var date = bucketDate(bucket, unit);
        if (unit === 'month') return MONTHS_LONG[date.getMonth()] + ' ' + date.getFullYear();
        if (unit === 'day') {
            return DAYS[date.getDay()] + ' ' + date.getDate() + ' ' + MONTHS[date.getMonth()] +
                ' ' + date.getFullYear();
        }
        return DAYS[date.getDay()] + ' ' + date.getDate() + ' ' + MONTHS[date.getMonth()] + ', ' +
            pad(date.getHours()) + ':00–' + pad((date.getHours() + 1) % 24) + ':00';
    }

    /** An exact instant from the API, in this browser's time: date and clock. */
    function formatInstant(iso) {
        if (!iso) return null;
        var date = new Date(iso);
        if (isNaN(date.getTime())) return null;

        return DAYS[date.getDay()] + ' ' + date.getDate() + ' ' + MONTHS[date.getMonth()] + ' ' +
            date.getFullYear() + ', ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
    }

    function formatWindow(window_) {
        var from = window_.from;
        var last = new Date(window_.to.getTime() - 1000);
        var same = from.getFullYear() === last.getFullYear();

        function part(date, withYear) {
            return date.getDate() + ' ' + MONTHS[date.getMonth()] + (withYear ? ' ' + date.getFullYear() : '');
        }

        return part(from, !same) + ' – ' + part(last, true);
    }

    /* --------------------------------------------------------- the columns */

    function niceCeil(value) {
        if (value <= 5) return Math.max(1, Math.ceil(value));

        var magnitude = Math.pow(10, Math.floor(Math.log10(value)));
        var scaled = value / magnitude;
        var step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 2.5 ? 2.5 : scaled <= 5 ? 5 : 10;

        return step * magnitude;
    }

    /**
     * A column per bucket, drawn as SVG.
     *
     * One series, so there is no legend to draw — the panel heading says what
     * is plotted. Only the peak carries a direct label; every other value is a
     * hover away or in the table underneath, because a number over every
     * column is noise nobody reads.
     */
    function columnChart(container, points, options) {
        var settings = options || {};
        container.innerHTML = '';

        if (!points.length) {
            container.innerHTML = '<div class="chart-empty">No opens in this window.</div>';
            return;
        }

        var width = Math.max(320, container.clientWidth || 720);
        var height = settings.height || 260;
        var padLeft = 48;
        var padRight = 14;
        var padTop = 22;
        var padBottom = 28;

        var plotWidth = width - padLeft - padRight;
        var plotHeight = height - padTop - padBottom;

        var peak = 0;
        var peakIndex = -1;
        points.forEach(function (point, index) {
            if (point.value > peak) {
                peak = point.value;
                peakIndex = index;
            }
        });

        var top = niceCeil(peak || 1);
        var band = plotWidth / points.length;
        // Capped, and never filling its slot: the leftover band is the 2px
        // surface gap that separates neighbouring columns.
        var barWidth = Math.max(2, Math.min(24, band - 2));

        function y(value) {
            return padTop + plotHeight - (value / top) * plotHeight;
        }

        var svg = ['<svg viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="' +
            (settings.ariaLabel || 'Opens over time') + '">'];

        /*
         * Gridlines and their values. Hairline, solid, one step off the
         * surface — present, never competing with the data.
         *
         * Halves are only useful once there is something to halve: a chart
         * whose busiest column is 1 would otherwise be labelled "0, 1, 1",
         * because both the midpoint and the top round to the same integer.
         */
        var ticks = top <= 4
            ? Array.from({ length: top + 1 }, function (unused, index) { return index; })
            : [0, top / 2, top];

        ticks.forEach(function (value) {
            var lineY = Math.round(y(value)) + 0.5;
            svg.push('<line class="grid-line" x1="' + padLeft + '" y1="' + lineY + '" x2="' +
                (width - padRight) + '" y2="' + lineY + '" />');
            svg.push('<text class="axis-text value" x="' + (padLeft - 9) + '" y="' + (lineY + 3.5) +
                '" text-anchor="end">' + formatCount(Math.round(value)) + '</text>');
        });

        // At most a dozen x labels, always including the first and the last.
        var labelStep = Math.max(1, Math.ceil(points.length / 12));

        points.forEach(function (point, index) {
            var x = padLeft + band * index + (band - barWidth) / 2;

            if (point.value > 0) {
                var barHeight = Math.max(2, padTop + plotHeight - y(point.value));
                var barTop = padTop + plotHeight - barHeight;
                var radius = Math.min(4, barWidth / 2, barHeight);

                // Rounded at the data end, square at the baseline.
                svg.push('<path class="bar' + (settings.dimUnlessPeak && index !== peakIndex ? ' dim' : '') +
                    '" d="M' + x + ' ' + (barTop + barHeight) +
                    ' L' + x + ' ' + (barTop + radius) +
                    ' Q' + x + ' ' + barTop + ' ' + (x + radius) + ' ' + barTop +
                    ' L' + (x + barWidth - radius) + ' ' + barTop +
                    ' Q' + (x + barWidth) + ' ' + barTop + ' ' + (x + barWidth) + ' ' + (barTop + radius) +
                    ' L' + (x + barWidth) + ' ' + (barTop + barHeight) + ' Z" />');

                if (index === peakIndex && peak > 0) {
                    svg.push('<text class="bar-label" x="' + (x + barWidth / 2) + '" y="' +
                        (barTop - 7) + '">' + formatCount(point.value) + '</text>');
                }
            }

            if (index % labelStep === 0 || index === points.length - 1) {
                svg.push('<text class="axis-text" x="' + (padLeft + band * index + band / 2) + '" y="' +
                    (height - 9) + '" text-anchor="middle">' + point.label + '</text>');
            }

            // The hit target is the whole band, full height — a 2px column is
            // impossible to hover, and a quiet day has to be readable too.
            svg.push('<rect class="bar-hit" x="' + (padLeft + band * index) + '" y="' + padTop +
                '" width="' + band + '" height="' + plotHeight + '" data-index="' + index + '" />');
        });

        svg.push('</svg>');
        container.innerHTML = svg.join('');

        attachTooltip(container, points);
    }

    function attachTooltip(container, points) {
        var tip = document.createElement('div');
        tip.className = 'chart-tip';
        container.appendChild(tip);

        container.querySelectorAll('.bar-hit').forEach(function (hit) {
            hit.addEventListener('mouseenter', function () {
                var point = points[Number(hit.dataset.index)];
                tip.innerHTML = '<div>' + point.tip + '</div><div class="tip-value">' +
                    Number(point.value).toLocaleString() + (point.value === 1 ? ' open' : ' opens') + '</div>';
                tip.style.display = 'block';

                var box = hit.getBoundingClientRect();
                var frame = container.getBoundingClientRect();
                var left = box.left - frame.left + box.width / 2 - tip.offsetWidth / 2;

                tip.style.left = Math.max(4, Math.min(left, frame.width - tip.offsetWidth - 4)) + 'px';
                tip.style.top = '6px';
            });

            hit.addEventListener('mouseleave', function () {
                tip.style.display = 'none';
            });
        });
    }

    function seriesPoints(series, unit) {
        return series.map(function (row) {
            return {
                value: row.opens,
                label: axisLabel(row.bucket, unit),
                tip: fullLabel(row.bucket, unit),
            };
        });
    }

    function numbersTable(series, unit, container) {
        if (!series.length) {
            container.innerHTML = '<div class="state-note">Nothing to show.</div>';
            return;
        }

        var rows = series.map(function (row) {
            return '<tr><td>' + escapeHtml(fullLabel(row.bucket, unit)) + '</td><td class="num">' +
                Number(row.opens).toLocaleString() + '</td></tr>';
        });

        container.innerHTML =
            '<table><thead><tr><th>' + (unit === 'hour' ? 'Hour' : unit === 'month' ? 'Month' : 'Day') +
            '</th><th class="num">Opens</th></tr></thead><tbody>' + rows.join('') + '</tbody></table>';
    }

    /* --------------------------------------------------------------- tiles */

    function deltaHtml(total, previous) {
        if (!previous) {
            return total > 0
                ? '<span class="delta flat">No opens in the period before</span>'
                : '<span class="delta flat">Nothing in either period</span>';
        }

        var change = (total - previous) / previous;
        var direction = change > 0.0001 ? 'up' : change < -0.0001 ? 'down' : 'flat';
        var sign = direction === 'up' ? '+' : direction === 'down' ? '−' : '';
        var percent = Math.abs(change) >= 10 ? Math.round(Math.abs(change) * 100) : (Math.abs(change) * 100).toFixed(1);

        return '<span class="delta ' + direction + '">' + sign + percent + '%</span>' +
            ' <span class="muted">vs the ' + previous.toLocaleString() + ' before</span>';
    }

    function tile(label, value, sub, small) {
        return '<div class="kpi"><div class="kpi-label">' + escapeHtml(label) + '</div>' +
            '<div class="kpi-value' + (small ? ' small' : '') + '">' + value + '</div>' +
            '<div class="kpi-sub">' + (sub || '') + '</div></div>';
    }

    function peakOf(series, unit) {
        var best = null;
        series.forEach(function (row) {
            if (!best || row.opens > best.opens) best = row;
        });

        if (!best || !best.opens) return null;
        return { label: fullLabel(best.bucket, unit), opens: best.opens };
    }

    function escapeHtml(value) {
        return String(value === null || value === undefined ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    /* ------------------------------------------------------------ overview */

    function paintOverview(data, window_) {
        var opened = data.assets.filter(function (row) { return row.opens > 0; }).length;
        var peak = peakOf(data.series, data.unit);

        var latest = null;
        data.assets.forEach(function (row) {
            if (row.lastOpenAt && (!latest || row.lastOpenAt > latest)) latest = row.lastOpenAt;
        });

        var unitWord = data.unit === 'hour' ? 'hour' : data.unit === 'month' ? 'month' : 'day';

        $('overviewKpis').innerHTML = [
            tile('Opens in this window', formatCount(data.total), deltaHtml(data.total, data.previousTotal)),
            tile('Creatives opened', formatCount(opened),
                '<span class="muted">of ' + data.assets.filter(function (row) { return !row.deleted; }).length +
                ' in the studio</span>'),
            tile('Busiest ' + unitWord,
                peak ? escapeHtml(peak.label) : '—',
                peak ? '<span class="muted">' + peak.opens.toLocaleString() + ' opens</span>' : '', true),
            tile('Most recent open', escapeHtml(formatInstant(latest) || '—'),
                latest ? '<span class="muted">your local time</span>' : '', true),
        ].join('');

        $('overviewChartHint').textContent = 'One column per ' + unitWord + ' · ' + formatWindow(window_);
        columnChart($('overviewChart'), seriesPoints(data.series, data.unit), { ariaLabel: 'Opens per ' + unitWord });
        numbersTable(data.series, data.unit, $('overviewNumbers'));

        paintAssetRows(data.assets);
    }

    function paintAssetRows(assets) {
        var body = $('assetRows');
        body.innerHTML = '';

        // Creatives nobody opened are kept and shown at zero — that is often
        // the most useful row on the page, and dropping it would make the one
        // question the page cannot answer "which of these is doing nothing?".
        $('assetsEmpty').style.display = assets.length ? 'none' : '';

        assets.forEach(function (row) {
            var tr = document.createElement('tr');
            tr.className = 'clickable';

            var share = Math.round(row.share * 1000) / 10;
            var typeLabel = row.assetType === 'timer' ? 'Countdown timer' : 'Dynamic image';

            tr.innerHTML =
                '<td><div class="asset-name"><span class="badge accent">' + escapeHtml(row.assetId) + '</span>' +
                '<span><strong>' + escapeHtml(row.name) + '</strong>' +
                '<div class="asset-sub">' + (row.deleted
                    ? 'deleted — its opens are kept'
                    : 'by ' + escapeHtml(row.createdByName || 'someone who has since left')) +
                '</div></span></div></td>' +
                '<td>' + typeLabel + '</td>' +
                '<td class="num">' + Number(row.opens).toLocaleString() + '</td>' +
                '<td><div class="share"><div class="share-track"><div class="share-fill" style="width: ' +
                (row.share * 100).toFixed(1) + '%"></div></div><span class="share-text">' +
                (row.opens ? share + '%' : '—') + '</span></div></td>' +
                '<td>' + (formatInstant(row.lastOpenAt) || '<span class="muted">never</span>') + '</td>';

            tr.addEventListener('click', function () {
                openAsset(row.assetType, row.assetId, true);
            });

            body.appendChild(tr);
        });
    }

    /* -------------------------------------------------------------- detail */

    function previewUrl(assetType, assetId) {
        var path = assetType === 'timer'
            ? '/api/v1/timer/' + encodeURIComponent(assetId) + '.gif'
            : '/api/v1/render/' + encodeURIComponent(assetId);

        return window.apiUrl(path + '?' + PREVIEW_PARAM + '=1');
    }

    function paintDetail(data, window_) {
        var peak = peakOf(data.series, data.unit);
        var unitWord = data.unit === 'hour' ? 'hour' : data.unit === 'month' ? 'month' : 'day';

        $('detailName').textContent = data.name;
        $('detailMeta').innerHTML =
            (data.assetType === 'timer' ? 'Countdown timer' : 'Dynamic image') +
            ' · <span class="badge accent">' + escapeHtml(data.assetId) + '</span>' +
            (data.deleted
                ? ' · <span class="muted">deleted from the library — its opens are kept</span>'
                : ' · by ' + escapeHtml(data.createdByName || 'someone who has since left'));

        $('detailThumb').innerHTML = '<span class="muted" style="font-size: 12px;">no preview</span>';

        if (!data.deleted) {
            // Swapped in only once it has actually loaded, so a creative whose
            // source image has gone shows the note rather than a broken icon.
            var thumb = new Image();
            thumb.alt = '';
            thumb.onload = function () {
                $('detailThumb').innerHTML = '';
                $('detailThumb').appendChild(thumb);
            };
            thumb.src = previewUrl(data.assetType, data.assetId);
        }

        var busiestHour = -1;
        data.hourOfDay.forEach(function (opens, hour) {
            if (busiestHour < 0 || opens > data.hourOfDay[busiestHour]) busiestHour = hour;
        });

        $('detailKpis').innerHTML = [
            tile('Opens in this window', formatCount(data.total), deltaHtml(data.total, data.previousTotal)),
            tile('Opens all time', formatCount(data.lifetime.opens),
                data.lifetime.firstOpenAt
                    ? '<span class="muted">first seen ' + escapeHtml(formatInstant(data.lifetime.firstOpenAt)) + '</span>'
                    : '<span class="muted">never opened</span>'),
            tile('Busiest ' + unitWord, peak ? escapeHtml(peak.label) : '—',
                peak ? '<span class="muted">' + peak.opens.toLocaleString() + ' opens</span>' : '', true),
            tile('Last opened', escapeHtml(formatInstant(data.lifetime.lastOpenAt) || '—'),
                data.lifetime.lastOpenAt ? '<span class="muted">your local time</span>' : '', true),
        ].join('');

        $('detailChartHint').textContent = 'One column per ' + unitWord + ' · ' + formatWindow(window_);
        columnChart($('detailChart'), seriesPoints(data.series, data.unit), { ariaLabel: 'Opens per ' + unitWord });
        numbersTable(data.series, data.unit, $('detailNumbers'));

        // The hour-of-day profile is a supporting chart, so only the peak hour
        // carries the accent — the rest are context for it.
        columnChart($('hourChart'), data.hourOfDay.map(function (opens, hour) {
            return {
                value: opens,
                label: pad(hour) + ':00',
                tip: pad(hour) + ':00–' + pad((hour + 1) % 24) + ':00',
            };
        }), { height: 200, dimUnlessPeak: true, ariaLabel: 'Opens by hour of the day' });
    }

    /* --------------------------------------------------------------- loads */

    function setBusy(container, message) {
        container.innerHTML = '<div class="state-note">' + message + '</div>';
    }

    /**
     * A response's JSON, or a readable error explaining why there isn't any.
     *
     * `response.json()` on an HTML body throws "Unexpected token '<'", which
     * says nothing about the actual problem: the API answered with a page
     * rather than data. That happens for one reason in practice — the server
     * handling the request does not have these routes, because it is still
     * running the build from before they existed. Saying so beats making
     * somebody decode a parser error.
     */
    async function readJson(response, url) {
        var body = await response.text();

        try {
            return JSON.parse(body);
        } catch (err) {
            if (response.status === 404) {
                throw new Error(
                    'The server has no ' + url.split('?')[0] + ' endpoint. It is running a build ' +
                    'from before Open Stats existed — restart it (npm start), or redeploy.'
                );
            }
            throw new Error('The server answered ' + response.status + ' with a page instead of data.');
        }
    }

    async function loadOverview() {
        var window_ = windowFor(state.range);
        $('rangeNote').textContent = formatWindow(window_);
        setBusy($('overviewChart'), 'Loading…');

        try {
            var url = '/api/v1/stats/overview?' + queryFor(window_);
            var response = await window.apiFetch(url);
            var data = await readJson(response, url);
            if (!response.ok) throw new Error(data.error || 'Could not load the stats');

            state.overview = { data: data, window: window_ };
            paintOverview(data, window_);
        } catch (err) {
            setBusy($('overviewChart'), err.message);
            window.toast(err.message, 'error');
        }
    }

    async function loadDetail(assetType, assetId) {
        var window_ = windowFor(state.range);
        $('rangeNote').textContent = formatWindow(window_);
        setBusy($('detailChart'), 'Loading…');

        try {
            var url = '/api/v1/stats/asset/' + encodeURIComponent(assetType) + '/' +
                encodeURIComponent(assetId) + '?' + queryFor(window_);
            var response = await window.apiFetch(url);
            var data = await readJson(response, url);
            if (!response.ok) throw new Error(data.error || 'Could not load the stats');

            state.detail = { data: data, window: window_ };
            paintDetail(data, window_);
        } catch (err) {
            setBusy($('detailChart'), err.message);
            window.toast(err.message, 'error');
        }
    }

    function reload() {
        if (state.view === 'detail' && state.asset) {
            loadDetail(state.asset.type, state.asset.id);
        } else {
            loadOverview();
        }
    }

    /* ---------------------------------------------------------------- views */

    function showView(view) {
        state.view = view;
        $('overviewView').style.display = view === 'overview' ? '' : 'none';
        $('detailView').style.display = view === 'detail' ? '' : 'none';
        document.querySelector('.app-content').scrollTop = 0;
    }

    /**
     * Everything on screen, as a query string.
     *
     * A stats page whose state lives only in memory cannot be sent to anyone:
     * the link you copy out of the address bar shows the reader last month's
     * default rather than the spike you were pointing at.
     */
    function currentUrl() {
        var params = new URLSearchParams();
        if (state.asset) {
            params.set('type', state.asset.type);
            params.set('id', state.asset.id);
        }
        if (state.range !== 'last30') params.set('range', state.range);
        if (state.range === 'custom') {
            if ($('fromDate').value) params.set('from', $('fromDate').value);
            if ($('toDate').value) params.set('to', $('toDate').value);
        }

        var query = params.toString();
        return window.location.pathname + (query ? '?' + query : '');
    }

    function rememberUrl(push) {
        if (push) history.pushState({}, '', currentUrl());
        else history.replaceState({}, '', currentUrl());
    }

    function openAsset(assetType, assetId, push) {
        state.asset = { type: assetType, id: assetId };
        showView('detail');
        if (push) rememberUrl(true);
        loadDetail(assetType, assetId);
    }

    function showOverview(push) {
        state.asset = null;
        showView('overview');
        if (push) rememberUrl(true);
        if (!state.overview) loadOverview(); else paintOverview(state.overview.data, state.overview.window);
    }

    function applyFromUrl() {
        var params = new URLSearchParams(window.location.search);
        var type = params.get('type');
        var id = params.get('id');

        var preset = params.get('range');
        if (preset && PRESETS.indexOf(preset) > -1) {
            if (params.get('from')) $('fromDate').value = params.get('from');
            if (params.get('to')) $('toDate').value = params.get('to');
            markRange(preset);
        }

        if (type && id) {
            state.asset = { type: type, id: id };
            showView('detail');
            loadDetail(type, id);
            // The overview sits behind it, so going back does not mean waiting.
            loadOverview();
            return;
        }

        showView('overview');
        loadOverview();
    }

    /* ---------------------------------------------------------------- wiring */

    /** Moves the selection without loading anything, for restoring a link. */
    function markRange(preset) {
        state.range = preset;

        document.querySelectorAll('.range-btn').forEach(function (button) {
            button.classList.toggle('active', button.dataset.range === preset);
        });

        $('customRange').classList.toggle('open', preset === 'custom');

        if (preset === 'custom' && !$('fromDate').value) {
            var today = new Date();
            $('toDate').value = toDateInput(today);
            $('fromDate').value = toDateInput(new Date(today.getTime() - 6 * 86400000));
        }
    }

    function selectRange(preset) {
        markRange(preset);

        // Custom waits for Apply: reloading on every keystroke of a date field
        // would fire a query for every half-typed year.
        if (preset === 'custom') return;

        state.overview = null;
        rememberUrl(false);
        reload();
    }

    function wire() {
        document.querySelectorAll('.range-btn').forEach(function (button) {
            button.addEventListener('click', function () {
                selectRange(button.dataset.range);
            });
        });

        $('applyCustom').addEventListener('click', function () {
            state.overview = null;
            rememberUrl(false);
            reload();
        });

        $('refreshBtn').innerHTML = window.shellIcon('refresh');
        $('refreshBtn').addEventListener('click', function () {
            state.overview = null;
            reload();
        });

        $('backToAll').addEventListener('click', function () {
            showOverview(true);
        });

        window.addEventListener('popstate', function () {
            var params = new URLSearchParams(window.location.search);
            var preset = params.get('range');

            if (preset && PRESETS.indexOf(preset) > -1) markRange(preset);
            else markRange('last30');

            state.overview = null;

            var type = params.get('type');
            var id = params.get('id');

            if (type && id) openAsset(type, id, false);
            else showOverview(false);
        });

        // The charts are sized from the container, so a resized window needs a
        // redraw rather than a stretched SVG.
        var resizeTimer = null;
        window.addEventListener('resize', function () {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(function () {
                if (state.view === 'detail' && state.detail) {
                    paintDetail(state.detail.data, state.detail.window);
                } else if (state.overview) {
                    paintOverview(state.overview.data, state.overview.window);
                }
            }, 180);
        });
    }

    function start() {
        wire();
        applyFromUrl();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
