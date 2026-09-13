/* ============================================================================
   Webengage Studio — countdown timer builder

   The form here is a direct edit of the JSON that gets stored in
   timers.config and read by the GIF renderer, so what the page holds in
   `state.config` is exactly what the server will draw. Nothing is translated
   between the two.

   Previews come from the server rather than being redrawn in the browser. A
   CSS mock-up would drift from the real output — font metrics, the 256-colour
   palette, where the block actually lands — so the preview endpoint renders a
   still through the same layout code the animation uses, and the builder just
   shows it.
   ========================================================================== */

(function () {
    const PREVIEW_DEBOUNCE_MS = 260;

    const ZONES = [
        'Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Asia/Tokyo', 'Asia/Jakarta',
        'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Moscow',
        'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
        'America/Sao_Paulo', 'Africa/Lagos', 'Africa/Johannesburg',
        'Australia/Sydney', 'Pacific/Auckland', 'UTC',
    ];

    const UNITS = ['days', 'hours', 'minutes', 'seconds'];

    const $ = (id) => document.getElementById(id);

    const state = {
        timerId: '',
        savedTimerId: '',
        config: defaultConfig(),
        previewTimer: null,
        previewToken: 0,
        block: null,
        naturalWidth: 0,
    };

    function defaultConfig() {
        return {
            source: { templateId: '', backgroundUrl: '' },
            endAt: '',
            timezone: 'Asia/Kolkata',
            evergreenSeconds: 0,
            canvasWidth: 600,
            background: '#ffffff',
            colors: 256,
            frames: 60,
            loop: false,
            style: {
                x: 0.5, y: 0.6,
                units: ['days', 'hours', 'minutes', 'seconds'],
                fontFamily: 'Arial', fontSize: 48, fontWeight: 'bold', color: '#ffffff',
                separator: ':', separatorColor: '#ffffff', gap: 10,
                showLabels: true,
                labels: { days: 'DAYS', hours: 'HOURS', minutes: 'MINS', seconds: 'SECS' },
                labelFontSize: 13, labelColor: '#ffffff', labelGap: 8, labelTracking: 1,
                plate: { mode: 'none', color: '#000000', opacity: 0.45, radius: 10, padX: 18, padY: 14 },
            },
            expired: { mode: 'message', text: 'SALE ENDED', color: '#ffffff', fontSize: 42, imageUrl: '' },
        };
    }

    /* ------------------------------------------------------------- toast */

    let toastTimer = null;
    function toast(message, kind) {
        const node = $('toast');
        node.textContent = message;
        node.className = `toast show${kind ? ' ' + kind : ''}`;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => node.classList.remove('show'), 3600);
    }

    /* -------------------------------------------------------------- views */

    window.switchView = function switchView(key) {
        const view = key === 'library' ? 'library' : 'builder';
        document.querySelectorAll('.page-view').forEach((node) => node.classList.remove('active'));
        $(`view-${view}`).classList.add('active');

        const url = new URL(window.location.href);
        url.searchParams.set('view', view);
        window.history.replaceState({}, '', url);

        if (view === 'library') loadLibrary();
    };

    /* ------------------------------------------------- reading the form */

    function readUnits() {
        const chosen = UNITS.filter(
            (unit) => document.querySelector(`[data-unit="${unit}"]`).checked
        );
        return chosen.length ? chosen : ['seconds'];
    }

    /** Turn a datetime-local value into the wall-clock string the server parses. */
    function readEndAt() {
        const value = $('endAt').value;
        if (!value) return '';
        return value.replace('T', ' ').padEnd(19, ':00').slice(0, 19);
    }

    function readForm() {
        const config = state.config;
        const useTemplate = $('sourceType').value === 'template';

        config.source = {
            templateId: useTemplate ? $('templateId').value : '',
            backgroundUrl: useTemplate ? '' : $('backgroundUrl').value.trim(),
        };

        const evergreen = $('mode').value === 'evergreen';
        config.evergreenSeconds = evergreen ? Math.max(1, Number($('evergreenHours').value) || 24) * 3600 : 0;
        config.endAt = evergreen ? '' : readEndAt();
        config.timezone = $('timezone').value;

        config.canvasWidth = Number($('canvasWidth').value) || 0;
        config.background = $('backgroundHex').value.trim() || '#ffffff';
        config.colors = Number($('colors').value) || 256;
        config.frames = Number($('frames').value) || 60;
        config.loop = $('loopEnabled').checked;

        config.style.units = readUnits();
        config.style.fontFamily = $('fontFamily').value;
        config.style.fontSize = Number($('fontSize').value) || 48;
        config.style.fontWeight = $('fontWeight').value;
        config.style.color = $('colorHex').value.trim() || '#ffffff';
        config.style.separatorColor = config.style.color;
        config.style.separator = $('separator').value;
        config.style.gap = Number($('gap').value) || 0;

        config.style.showLabels = $('showLabels').checked;
        config.style.labels = {
            days: $('labelDays').value,
            hours: $('labelHours').value,
            minutes: $('labelMinutes').value,
            seconds: $('labelSeconds').value,
        };
        config.style.labelFontSize = Number($('labelFontSize').value) || 13;
        config.style.labelGap = Number($('labelGap').value) || 0;
        config.style.labelColor = $('labelColor').value;

        config.style.plate.mode = $('plateMode').value;
        config.style.plate.color = $('plateColorHex').value.trim() || '#000000';
        config.style.plate.opacity = Number($('plateOpacity').value);
        config.style.plate.radius = Number($('plateRadius').value) || 0;
        config.style.plate.padX = Number($('platePadX').value) || 0;
        config.style.plate.padY = Number($('platePadY').value) || 0;

        config.expired.mode = $('expiredMode').value;
        config.expired.text = $('expiredText').value;
        config.expired.fontSize = Number($('expiredFontSize').value) || 42;
        config.expired.color = $('expiredColor').value;
        config.expired.imageUrl = $('expiredImageUrl').value.trim();

        return config;
    }

    /** Push `state.config` back into the controls, for loading a saved timer. */
    function writeForm() {
        const config = state.config;

        // A timer with neither set is a fresh one, which starts on the template tab.
        $('sourceType').value = config.source.backgroundUrl && !config.source.templateId ? 'url' : 'template';
        $('templateId').value = config.source.templateId || '';
        $('backgroundUrl').value = config.source.backgroundUrl || '';

        $('mode').value = config.evergreenSeconds > 0 ? 'evergreen' : 'fixed';
        $('evergreenHours').value = Math.max(1, Math.round((config.evergreenSeconds || 86400) / 3600));
        $('endAt').value = config.endAt ? config.endAt.replace(' ', 'T') : '';
        $('timezone').value = config.timezone || 'UTC';

        $('canvasWidth').value = config.canvasWidth || '';
        setColor('background', config.background);
        $('colors').value = config.colors;
        $('frames').value = config.frames;
        $('loopEnabled').checked = Boolean(config.loop);

        UNITS.forEach((unit) => {
            document.querySelector(`[data-unit="${unit}"]`).checked = config.style.units.includes(unit);
        });
        $('fontFamily').value = config.style.fontFamily;
        $('fontSize').value = config.style.fontSize;
        $('fontWeight').value = config.style.fontWeight;
        setColor('color', config.style.color);
        $('separator').value = config.style.separator;
        $('gap').value = config.style.gap;

        $('showLabels').checked = config.style.showLabels;
        $('labelDays').value = config.style.labels.days;
        $('labelHours').value = config.style.labels.hours;
        $('labelMinutes').value = config.style.labels.minutes;
        $('labelSeconds').value = config.style.labels.seconds;
        $('labelFontSize').value = config.style.labelFontSize;
        $('labelGap').value = config.style.labelGap;
        $('labelColor').value = config.style.labelColor;

        $('plateMode').value = config.style.plate.mode;
        setColor('plateColor', config.style.plate.color);
        $('plateOpacity').value = config.style.plate.opacity;
        $('plateRadius').value = config.style.plate.radius;
        $('platePadX').value = config.style.plate.padX;
        $('platePadY').value = config.style.plate.padY;

        $('expiredMode').value = config.expired.mode;
        $('expiredText').value = config.expired.text;
        $('expiredFontSize').value = config.expired.fontSize;
        $('expiredColor').value = config.expired.color;
        $('expiredImageUrl').value = config.expired.imageUrl || '';

        syncConditionalFields();
    }

    // A colour is edited as a swatch and as text; both have to agree.
    function setColor(base, value) {
        const hex = /^#[0-9a-fA-F]{6}$/.test(value) ? value : '#000000';
        if ($(base)) $(base).value = hex;
        if ($(`${base}Hex`)) $(`${base}Hex`).value = value;
    }

    function syncConditionalFields() {
        const useTemplate = $('sourceType').value === 'template';
        $('templateField').style.display = useTemplate ? '' : 'none';
        $('urlField').style.display = useTemplate ? 'none' : '';

        const evergreen = $('mode').value === 'evergreen';
        $('fixedFields').style.display = evergreen ? 'none' : '';
        $('evergreenFields').style.display = evergreen ? '' : 'none';

        const looping = $('loopEnabled').checked;
        const hasSeconds = document.querySelector('[data-unit="seconds"]').checked;

        $('frames').disabled = looping;
        $('loopHint').textContent = !looping
            ? 'The animation plays once and freezes on its last frame. Accurate, but a reader watching for longer than the animation sees it stop.'
            : hasSeconds
                // Explain the trade rather than just the switch: the seconds stay
                // exactly right forever, the larger units are the ones that drift.
                ? 'Runs one 60-frame seconds cycle on repeat, so it never visibly stops (the Frames setting is ignored). The seconds stay exactly correct; minutes and above hold at the moment the image was fetched and go stale while the reader watches. Each new open resyncs.'
                : 'Looping needs the Seconds unit — without it there is no column that completes a cycle, so this timer will still play once and freeze.';

        const plateMode = $('plateMode').value;
        $('plateFields').style.display = plateMode === 'none' ? 'none' : '';
        $('plateHint').textContent = plateMode === 'unit'
            // Pad X is clamped server-side to half the space between two groups, so
            // say where the room actually comes from rather than letting the
            // control look like it stopped working.
            ? 'One tile per unit, wrapping its digits and its label. Pad X is limited to half the gap between units — raise Gap, or clear the separator, for wider tiles.'
            : 'One panel behind the whole clock.';

        $('labelFields').style.display = $('showLabels').checked ? '' : 'none';

        const mode = $('expiredMode').value;
        $('expiredMessageFields').style.display = mode === 'message' ? '' : 'none';
        $('expiredImageField').style.display = mode === 'image' ? '' : 'none';
    }

    /* ------------------------------------------------------------ preview */

    function schedulePreview() {
        clearTimeout(state.previewTimer);
        state.previewTimer = setTimeout(renderPreview, PREVIEW_DEBOUNCE_MS);
    }

    async function renderPreview() {
        readForm();
        updateEmbed();

        if (!state.config.source.templateId && !state.config.source.backgroundUrl) {
            $('stage').style.display = 'none';
            $('canvasEmpty').style.display = '';
            $('canvasMeta').textContent = '';
            return;
        }

        const token = ++state.previewToken;
        $('stage').classList.add('busy');

        try {
            const response = await window.apiFetch('/api/v1/timers/preview', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ config: state.config }),
            });

            const data = await response.json();
            // A slower earlier request must not overwrite a newer preview.
            if (token !== state.previewToken) return;

            if (!response.ok) {
                $('canvasMeta').textContent = data.error || 'Could not render the preview';
                return;
            }

            $('previewImage').src = data.image;
            state.block = data.block;
            state.naturalWidth = data.width;
            $('stage').style.display = '';
            $('canvasEmpty').style.display = 'none';

            $('canvasMeta').innerHTML = [
                `${data.width} × ${data.height}px`,
                data.fits ? '' : '<strong>the clock does not fit on the creative</strong>',
                data.expired ? 'showing the expired state' : '',
            ].filter(Boolean).join(' &middot; ');

            positionHandle();
        } catch (err) {
            if (token === state.previewToken) $('canvasMeta').textContent = err.message;
        } finally {
            if (token === state.previewToken) $('stage').classList.remove('busy');
        }
    }

    /** Show the real animated GIF — the same bytes an inbox would receive. */
    async function renderAnimation() {
        readForm();

        if (!state.config.source.templateId && !state.config.source.backgroundUrl) {
            return toast('Pick a creative first', 'error');
        }
        if (!state.config.endAt && !state.config.evergreenSeconds) {
            return toast('Set a deadline first', 'error');
        }

        const button = $('animateBtn');
        button.disabled = true;
        button.textContent = 'Rendering…';

        try {
            const response = await window.apiFetch('/api/v1/timers/preview.gif', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ config: state.config }),
            });
            const data = await response.json();

            if (!response.ok) throw new Error(data.error || 'Could not render the timer');

            $('previewImage').src = data.image;
            $('canvasMeta').innerHTML =
                `${(data.bytes / 1024).toFixed(0)} KB &middot; ${data.frames} frames &middot; ` +
                (data.looping
                    ? 'loops forever &middot; seconds stay correct, larger units hold'
                    : 'plays once, then the next open fetches a fresh one');
        } catch (err) {
            toast(err.message, 'error');
        } finally {
            button.disabled = false;
            button.textContent = 'Play the real GIF';
        }
    }

    /* --------------------------------------------- dragging the block */

    function positionHandle() {
        const handle = $('blockHandle');
        if (!state.block || !state.naturalWidth) return (handle.style.display = 'none');

        const scale = $('previewImage').clientWidth / state.naturalWidth;
        handle.style.display = '';
        handle.style.left = `${state.block.left * scale}px`;
        handle.style.top = `${state.block.top * scale}px`;
        handle.style.width = `${state.block.width * scale}px`;
        handle.style.height = `${state.block.height * scale}px`;
    }

    function wireDragging() {
        const handle = $('blockHandle');
        let dragging = null;

        handle.addEventListener('pointerdown', (event) => {
            if (!state.block) return;
            event.preventDefault();
            handle.setPointerCapture(event.pointerId);
            handle.classList.add('dragging');

            const scale = $('previewImage').clientWidth / state.naturalWidth;
            dragging = {
                scale,
                startX: event.clientX,
                startY: event.clientY,
                originX: state.config.style.x,
                originY: state.config.style.y,
                imageWidth: $('previewImage').clientWidth,
                imageHeight: $('previewImage').clientHeight,
            };
        });

        handle.addEventListener('pointermove', (event) => {
            if (!dragging) return;

            // The stored position is the centre of the block as a fraction of
            // the canvas, so it survives the creative being re-rendered at a
            // different size.
            const dx = (event.clientX - dragging.startX) / dragging.imageWidth;
            const dy = (event.clientY - dragging.startY) / dragging.imageHeight;

            state.config.style.x = Math.min(1, Math.max(0, dragging.originX + dx));
            state.config.style.y = Math.min(1, Math.max(0, dragging.originY + dy));

            const halfWidth = state.block.width / 2;
            const halfHeight = state.block.height / 2;
            const handleNode = $('blockHandle');
            handleNode.style.left = `${(state.config.style.x * state.naturalWidth - halfWidth) * dragging.scale}px`;
            handleNode.style.top =
                `${(state.config.style.y * ($('previewImage').naturalHeight || 0) - halfHeight) * dragging.scale}px`;
        });

        const finish = (event) => {
            if (!dragging) return;
            dragging = null;
            handle.classList.remove('dragging');
            if (event.pointerId !== undefined && handle.hasPointerCapture(event.pointerId)) {
                handle.releasePointerCapture(event.pointerId);
            }
            renderPreview();
        };

        handle.addEventListener('pointerup', finish);
        handle.addEventListener('pointercancel', finish);

        window.addEventListener('resize', positionHandle);
        $('previewImage').addEventListener('load', positionHandle);
    }

    /* -------------------------------------------------------------- embed */

    function timerUrl(timerId) {
        return publicUrl(`/api/v1/timer/${timerId}.gif`);
    }

    function updateEmbed() {
        const id = state.savedTimerId;
        const width = state.config.canvasWidth || 600;

        if (!id) {
            $('embedCode').value = '<!-- Save the timer to get its URL -->';
            return;
        }

        const url = timerUrl(id) + (state.config.evergreenSeconds > 0 ? '?uid={{user.id}}' : '');

        $('embedCode').value =
            `<img src="${url}"\n     width="${width}" alt="Countdown"\n` +
            '     style="display:block;border:0;outline:none;text-decoration:none;" />';
    }

    async function copyText(text, button) {
        try {
            await navigator.clipboard.writeText(text);
            const original = button.textContent;
            button.textContent = 'Copied';
            setTimeout(() => { button.textContent = original; }, 1600);
        } catch (err) {
            toast('Could not copy — select the text instead', 'error');
        }
    }

    /* ------------------------------------------------------------ saving */

    async function save() {
        readForm();

        if (!state.config.source.templateId && !state.config.source.backgroundUrl) {
            return toast('Pick a creative first', 'error');
        }
        if (!state.config.endAt && !state.config.evergreenSeconds) {
            return toast('Set a deadline first', 'error');
        }

        const timerId = $('timerId').value.trim();
        const name = $('timerName').value.trim();

        if (!timerId) return toast('Give the timer an ID', 'error');
        if (!name) return toast('Give the timer a name', 'error');

        const button = $('saveBtn');
        button.disabled = true;

        try {
            const response = await window.apiFetch('/api/v1/timers', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ timerId, name, config: state.config }),
            });
            const data = await response.json();

            if (!response.ok) throw new Error(data.error || 'Could not save the timer');

            state.savedTimerId = timerId;
            updateEmbed();
            toast(`${timerId} saved`, 'ok');
        } catch (err) {
            toast(err.message, 'error');
        } finally {
            button.disabled = false;
        }
    }

    async function startNew() {
        state.config = defaultConfig();
        state.savedTimerId = '';

        const response = await window.apiFetch('/api/v1/timers/next-id');
        const data = await response.json();
        $('timerId').value = data.nextId;
        $('timerIdBadge').textContent = data.nextId;
        $('timerName').value = '';

        // A deadline two days out, so the preview shows a realistic clock.
        const soon = new Date(Date.now() + 2 * 86400000 + 3 * 3600000);
        soon.setSeconds(0, 0);
        state.config.endAt = soon.toISOString().slice(0, 19).replace('T', ' ');

        writeForm();
        renderPreview();
    }

    /* ----------------------------------------------------------- library */

    async function loadLibrary() {
        const grid = $('timerGrid');
        grid.innerHTML = '';

        try {
            const response = await window.apiFetch('/api/v1/timers');
            const data = await response.json();
            const timers = data.timers || [];

            $('libraryEmpty').style.display = timers.length ? 'none' : '';

            timers.forEach((timer) => grid.appendChild(timerCard(timer)));
        } catch (err) {
            toast(err.message, 'error');
        }
    }

    function timerCard(timer) {
        const card = document.createElement('div');
        card.className = 'timer-card';

        const deadline = timer.config.evergreenSeconds > 0
            ? `${Math.round(timer.config.evergreenSeconds / 3600)}h from first open`
            : `${timer.config.endAt || 'no deadline set'} ${timer.config.timezone || ''}`.trim();

        card.innerHTML = `
            <img class="timer-thumb" alt="${timer.name}" src="${timerUrl(timer.timer_id)}" loading="lazy" />
            <div class="timer-card-body">
                <div class="timer-card-title">
                    <h3></h3>
                    <span class="badge accent"></span>
                </div>
                <p class="timer-meta"></p>
                <div class="btn-row">
                    <button class="btn small" data-action="edit">Edit</button>
                    <button class="btn small" data-action="copy">Copy URL</button>
                    <button class="btn small danger" data-action="delete">Delete</button>
                </div>
            </div>`;

        card.querySelector('h3').textContent = timer.name;
        card.querySelector('.badge').textContent = timer.timer_id;
        card.querySelector('.timer-meta').textContent = deadline;

        card.querySelector('[data-action="edit"]').addEventListener('click', () => {
            state.config = timer.config;
            state.savedTimerId = timer.timer_id;
            $('timerId').value = timer.timer_id;
            $('timerIdBadge').textContent = timer.timer_id;
            $('timerName').value = timer.name;
            writeForm();
            switchView('builder');
            renderPreview();
        });

        card.querySelector('[data-action="copy"]').addEventListener('click', (event) =>
            copyText(timerUrl(timer.timer_id), event.currentTarget)
        );

        card.querySelector('[data-action="delete"]').addEventListener('click', async () => {
            if (!window.confirm(`Delete ${timer.timer_id}? Any campaign using it starts showing nothing.`)) return;

            try {
                const response = await window.apiFetch(`/api/v1/timers/${timer.timer_id}/delete`, { method: 'POST' });
                const data = await response.json();
                if (!response.ok) throw new Error(data.error || 'Could not delete the timer');
                toast(`${timer.timer_id} deleted`, 'ok');
                loadLibrary();
            } catch (err) {
                toast(err.message, 'error');
            }
        });

        return card;
    }

    /* -------------------------------------------------------------- boot */

    async function loadTemplates() {
        const select = $('templateId');

        try {
            const response = await window.apiFetch('/api/v1/templates');
            const data = await response.json();
            const templates = data.templates || [];

            select.innerHTML = templates.length
                ? templates.map((t) => `<option value="${t.template_id}">${t.template_id}</option>`).join('')
                : '<option value="">No templates yet — build one in Dynamic Images</option>';
        } catch (err) {
            select.innerHTML = '<option value="">Could not load templates</option>';
        }
    }

    function wireControls() {
        $('timezone').innerHTML = ZONES.map((zone) => `<option value="${zone}">${zone}</option>`).join('');

        // Collapsible groups
        document.querySelectorAll('.group-title').forEach((button) => {
            button.addEventListener('click', () => button.closest('.group').classList.toggle('collapsed'));
        });
        document.querySelectorAll('.group-title span').forEach((cap) => {
            cap.innerHTML = window.shellIcon('chevronDown', 'sm');
        });
        $('refreshBtn').innerHTML = window.shellIcon('refresh', 'sm');

        // Colour swatch and hex field stay in step
        [['background', 'backgroundHex'], ['color', 'colorHex'], ['plateColor', 'plateColorHex']]
            .forEach(([swatch, hex]) => {
                $(swatch).addEventListener('input', () => {
                    $(hex).value = $(swatch).value;
                    schedulePreview();
                });
                $(hex).addEventListener('input', () => {
                    if (/^#[0-9a-fA-F]{6}$/.test($(hex).value)) $(swatch).value = $(hex).value;
                    schedulePreview();
                });
            });

        ['sourceType', 'mode', 'plateMode', 'showLabels', 'expiredMode', 'loopEnabled'].forEach((id) => {
            $(id).addEventListener('change', () => {
                syncConditionalFields();
                schedulePreview();
            });
        });

        document.querySelectorAll('.panel-body input, .panel-body select').forEach((node) => {
            if (['timerId', 'timerName', 'embedCode'].includes(node.id)) return;
            node.addEventListener('input', schedulePreview);
            node.addEventListener('change', schedulePreview);
        });

        // Whether looping is possible depends on the Seconds unit, so the hint
        // has to follow the unit checkboxes as well as the switch itself.
        document.querySelectorAll('[data-unit]').forEach((node) =>
            node.addEventListener('change', syncConditionalFields)
        );

        $('refreshBtn').addEventListener('click', renderPreview);
        $('animateBtn').addEventListener('click', renderAnimation);
        $('saveBtn').addEventListener('click', save);
        $('newBtn').addEventListener('click', startNew);
        $('reloadLibraryBtn').addEventListener('click', loadLibrary);

        $('copyEmbedBtn').addEventListener('click', (event) =>
            copyText($('embedCode').value, event.currentTarget)
        );
        $('copyUrlBtn').addEventListener('click', (event) => {
            if (!state.savedTimerId) return toast('Save the timer first', 'error');
            copyText(timerUrl(state.savedTimerId), event.currentTarget);
        });

        wireDragging();
    }

    document.addEventListener('DOMContentLoaded', async () => {
        wireControls();
        await loadTemplates();
        await startNew();

        if (new URLSearchParams(window.location.search).get('view') === 'library') switchView('library');
    });
})();
