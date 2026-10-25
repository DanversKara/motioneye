/* motionEye grid enhancements — overlay, loaded after main.js.
 *
 * Adds, without modifying any upstream file except main.html (two lines
 * to load this file and grid.css):
 *   1. Per-camera frame sizes: a button on every frame cycles
 *      normal -> tiny -> large -> normal. Tiny tiles are for cameras
 *      you just want to glance at (e.g. ESP32 cameras parked at the
 *      bottom of the grid); large tiles give an important camera two
 *      cells of width. Dragging a frame's corner instead sets ANY
 *      width (15–100% of the row, 1% steps), shown as "C" on the
 *      button — the presets alone always over- or undershoot a
 *      space, a free width fills it exactly. Sizes persist
 *      server-side in the user's prefs (a `camera_sizes` key
 *      piggybacking on the page's own save/load functions) with a
 *      localStorage fallback on old versions.
 *   1b. Float packing (grid.css): frames float left instead of
 *      sitting inline-block, so a short frame tucks into the empty
 *      height beside a taller one instead of leaving a black band
 *      no later frame can use. Widths (preset or custom %) still
 *      resolve against the container, and DOM order — hence drag
 *      reorder — is unchanged.
 *   2. Inset picture-in-picture: the P button on a frame adds a small
 *      live inset of ANOTHER camera INSIDE that frame. The inset drags
 *      anywhere within the host frame and resizes by its corner
 *      handle, both clamped to the host's bounds. It has NO title bar
 *      at all (a title would cover part of the host's video): the
 *      video fills the whole inset, and the camera dropdown + close
 *      button only appear as a slim strip over the top of the inset
 *      while you hover it, or after you tap it (tap again to hide).
 *      One inset per host; pressing P again removes it. Insets
 *      survive motionEye rebuilding the frames.
 *   3. Chrome toggle + auto-hide: a circle button (top-center, with
 *      the motionEye icon) appears whenever the mouse moves or the
 *      screen is tapped, and hides after 4 seconds idle — together
 *      with the header, the footer and all per-frame buttons (size,
 *      PiP, drag grips), so nothing sits on top of the video while
 *      you watch. Clicking the circle shows the header; clicking
 *      again hides it. Hiding the header also drops the grid's
 *      top/bottom padding (see grid.css), so the video slides up and
 *      covers the freed space instead of leaving a gap. Never hides
 *      while the settings panel or a modal is open.
 *   4. Reorder handles always on: upstream hides the drag handles
 *      until the "Enable Reordering" switch is turned on (and turns it
 *      back off whenever frames are rebuilt), which is why reordering
 *      feels missing. This overlay re-enables them after every frame
 *      rebuild. On versions without upstream reordering at all, a
 *      fallback drag handle is added instead (order kept in
 *      localStorage).
 *
 * Vanilla JS, no jQuery dependency; every upstream global is used only
 * if it exists, so this file degrades gracefully on older versions.
 */
(function () {
    'use strict';

    var LS_SIZES = 'motioneye-grid-sizes';
    var LS_ORDER = 'motioneye-grid-order';
    var SIZE_CYCLE = ['normal', 'tiny', 'large'];
    var SIZE_LETTER = {normal: 'N', tiny: 'T', large: 'L'};
    var SIZE_TITLE = {
        normal: 'Frame size: normal — click for tiny',
        tiny: 'Frame size: tiny — click for large',
        large: 'Frame size: large — click for normal'
    };
    var HIDE_IDLE_MS = 4000;

    /* camera id -> 'tiny' | 'large' | <percent number> (normal = absent).
     * A number is a custom width: percent of the page-container width,
     * set by dragging a frame's corner. Percents survive window and
     * column-count changes, unlike pixel widths. */
    var sizes = {};
    var LS_LAYOUT = 'motioneye-grid-layout';
    var LS_FREE = 'motioneye-grid-free';
    var LS_BAR_POS = 'motioneye-grid-bar-pos';
    /* free layout: camera id -> {left (%), top (px), z}. Left/width
     * are percents (they scale with the window); top is pixels
     * (percent-of-height would be circular, since the container's
     * height is itself derived from the frames' bottoms). */
    var layout = {};
    var freeMode = false;
    var freeTopZ = 10;
    var insets = {}; /* hostId -> {cameraId, left, top, width} */
    var upstreamReorder = null; /* true/false once detected */

    function $(sel, root) {
        return (root || document).querySelector(sel);
    }

    function $$(sel, root) {
        return Array.prototype.slice.call((root || document).querySelectorAll(sel));
    }

    function getFrames() {
        return $$('div.page-container div.camera-frame');
    }

    function frameId(frame) {
        return frame.id ? frame.id.substring(6) : '';
    }

    function frameName(frame) {
        var span = frame.querySelector('span.camera-name');
        var name = span && span.textContent ? span.textContent.trim() : '';
        return name || ('Camera ' + frameId(frame));
    }

    function frameStreamSrc(frame) {
        var img = frame.querySelector('img.camera');
        return img && img.getAttribute('src') ? img.getAttribute('src') : '';
    }

    /* ── Sizes: storage ─────────────────────────────────────────── */

    function loadLocalSizes() {
        try {
            var raw = window.localStorage.getItem(LS_SIZES);
            return raw ? JSON.parse(raw) : {};
        } catch (e) {
            return {};
        }
    }

    function saveLocalSizes() {
        try {
            window.localStorage.setItem(LS_SIZES, JSON.stringify(sizes));
        } catch (e) { /* private mode etc. — sizes still apply this session */ }
    }

    function applySizes() {
        getFrames().forEach(function (frame) {
            var id = frameId(frame);
            frame.classList.remove('grid-size-tiny', 'grid-size-large');
            frame.style.width = '';
            var cur = sizes[id];
            var btn = frame.querySelector('.grid-size-btn');
            if (typeof cur === 'number') {
                /* custom percent width: inline style beats the column
                 * width rule, and no size class (whose !important
                 * width would override the inline style) */
                frame.style.width = cur + '%';
                if (btn) {
                    btn.textContent = 'C';
                    btn.title = 'Frame size: custom ' + cur + '% — click for tiny';
                }
            } else {
                if (cur === 'tiny') {
                    frame.classList.add('grid-size-tiny');
                } else if (cur === 'large') {
                    frame.classList.add('grid-size-large');
                }
                if (btn) {
                    var preset = cur || 'normal';
                    btn.textContent = SIZE_LETTER[preset];
                    btn.title = SIZE_TITLE[preset];
                }
            }
        });
        if (freeMode) {
            updateFreeHeight();
        }
    }

    function applySizeToMap(id, size) {
        if (size === 'normal') {
            delete sizes[id];
        } else {
            sizes[id] = size;
        }
        applySizes();
    }

    function persistSizes() {
        saveLocalSizes();
        if (typeof window.savePrefs === 'function') {
            try {
                window.savePrefs();
            } catch (e) { /* prefs save is best-effort here */ }
        }
    }

    function setSize(id, size) {
        applySizeToMap(id, size);
        persistSizes();
    }

    /* ── Free layout: storage ───────────────────────────────────── */

    function loadLocalLayout() {
        try {
            var raw = window.localStorage.getItem(LS_LAYOUT);
            return raw ? JSON.parse(raw) : {};
        } catch (e) {
            return {};
        }
    }

    function saveLocalLayout() {
        try {
            window.localStorage.setItem(LS_LAYOUT, JSON.stringify(layout));
        } catch (e) { /* ignore */ }
    }

    function persistLayout() {
        saveLocalLayout();
        if (typeof window.savePrefs === 'function') {
            try {
                window.savePrefs();
            } catch (e) { /* prefs save is best-effort here */ }
        }
    }

    function loadLocalFree() {
        try {
            return window.localStorage.getItem(LS_FREE) === '1';
        } catch (e) {
            return false;
        }
    }

    function saveLocalFree() {
        try {
            window.localStorage.setItem(LS_FREE, freeMode ? '1' : '0');
        } catch (e) { /* ignore */ }
    }

    function persistFreeMode() {
        saveLocalFree();
        if (typeof window.savePrefs === 'function') {
            try {
                window.savePrefs();
            } catch (e) { /* prefs save is best-effort here */ }
        }
    }

    /* Corner-drag resize: pulling a frame's bottom-right corner sets
     * its width CONTINUOUSLY, as a percent of the page-container
     * width (15–100%, 1% steps), live-previewed while dragging and
     * saved on release. Percent widths pack rows exactly (unlike the
     * three coarse presets, which always over- or undershoot a
     * space) and survive window resizes and column-count changes.
     * The size button still cycles the three presets; a custom width
     * shows as "C", and clicking it restarts the preset cycle. */
    function addResizeDrag(handle, frame, id) {
        handle.addEventListener('pointerdown', function (e) {
            if (!e.isPrimary || e.button !== 0) {
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            var container = $('div.page-container');
            var containerWidth = container ? container.getBoundingClientRect().width : 0;
            var startWidth = frame.getBoundingClientRect().width;
            var startX = e.clientX;
            var moved = false;
            function onMove(ev) {
                if (ev.pointerId !== e.pointerId) {
                    return;
                }
                if (!containerWidth) {
                    return;
                }
                var pct = Math.round((startWidth + (ev.clientX - startX)) / containerWidth * 100);
                pct = Math.max(15, Math.min(100, pct));
                applySizeToMap(id, pct);
                moved = true;
            }
            function onUp(ev) {
                if (ev.pointerId !== e.pointerId) {
                    return;
                }
                document.removeEventListener('pointermove', onMove);
                document.removeEventListener('pointerup', onUp);
                document.removeEventListener('pointercancel', onUp);
                if (moved) {
                    persistSizes();
                }
            }
            document.addEventListener('pointermove', onMove);
            document.addEventListener('pointerup', onUp);
            document.addEventListener('pointercancel', onUp);
        });
    }

    function cycleSize(id) {
        var cur = sizes[id];
        /* a custom width restarts the preset cycle at tiny */
        if (typeof cur === 'number') {
            setSize(id, 'tiny');
            return;
        }
        var preset = cur || 'normal';
        var next = SIZE_CYCLE[(SIZE_CYCLE.indexOf(preset) + 1) % SIZE_CYCLE.length];
        setSize(id, next);
    }

    /* ── Free layout: drag anywhere, any size ─────────────────────
     * Grid mode lays frames out in flow (rows). Free mode makes every
     * frame absolutely positioned inside the page-container, so it
     * can sit anywhere — including the gaps flow layout can never
     * fill — and overlap others. Widths keep working exactly as in
     * grid mode (presets or custom %); only position is free, and
     * height still follows the video's aspect ratio (a free height
     * would crop or stretch the picture).
     *   - move: drag a frame's ✥ handle (top-center, free mode only).
     *   - resize: the corner handle, as in grid mode (width %).
     *   - the dragged frame comes to the front (z remembered).
     *   - the container's height is derived (tallest frame bottom),
     *     so the footer stays below the layout. */

    function updateFreeHeight() {
        var container = $('div.page-container');
        if (!container || !freeMode) {
            return;
        }
        var cr = container.getBoundingClientRect();
        var maxBottom = 0;
        getFrames().forEach(function (frame) {
            var bottom = frame.getBoundingClientRect().bottom - cr.top;
            if (bottom > maxBottom) {
                maxBottom = bottom;
            }
        });
        container.style.minHeight = Math.ceil(maxBottom) + 'px';
    }

    function defaultFreeSpot() {
        /* a camera with no saved spot parks below the others */
        var container = $('div.page-container');
        var top = 0;
        if (container) {
            var cr = container.getBoundingClientRect();
            getFrames().forEach(function (frame) {
                if (frame.style.position === 'absolute') {
                    var bottom = frame.getBoundingClientRect().bottom - cr.top;
                    if (bottom > top) {
                        top = bottom;
                    }
                }
            });
        }
        return { left: 0, top: Math.ceil(top) };
    }

    function applyFreeFrame(frame) {
        var id = frameId(frame);
        var st = layout[id];
        if (!st) {
            st = defaultFreeSpot();
            layout[id] = st;
            persistLayout();
        }
        frame.style.position = 'absolute';
        frame.style.left = st.left + '%';
        frame.style.top = st.top + 'px';
        if (st.z) {
            frame.style.zIndex = st.z;
            if (st.z > freeTopZ) {
                freeTopZ = st.z;
            }
        }
    }

    function applyFreeToAll() {
        if (!freeMode) {
            return;
        }
        getFrames().forEach(applyFreeFrame);
        updateFreeHeight();
    }

    function convertFreeLayout() {
        var container = $('div.page-container');
        if (!container) {
            return;
        }
        var cr = container.getBoundingClientRect();
        if (!cr.width) {
            return;
        }
        /* measure ALL first: absolutizing one frame shifts the flow
         * positions of the ones after it */
        var measured = getFrames().map(function (frame) {
            var r = frame.getBoundingClientRect();
            return {
                id: frameId(frame),
                left: Math.round((r.left - cr.left) / cr.width * 1000) / 10,
                top: Math.round(r.top - cr.top)
            };
        });
        layout = {};
        measured.forEach(function (m) {
            layout[m.id] = { left: m.left, top: m.top };
        });
        persistLayout();
    }

    function setFreeMode(on, convertIfEmpty) {
        freeMode = on;
        document.body.classList.toggle('grid-free', on);
        var btn = document.getElementById('gridFreeBtn');
        if (btn) {
            btn.classList.toggle('active', on);
        }
        var container = $('div.page-container');
        if (!on) {
            getFrames().forEach(function (frame) {
                frame.style.position = '';
                frame.style.left = '';
                frame.style.top = '';
                frame.style.zIndex = '';
            });
            if (container) {
                container.style.minHeight = '';
            }
            return;
        }
        if (convertIfEmpty && Object.keys(layout).length === 0) {
            convertFreeLayout();
        }
        applyFreeToAll();
    }

    function addFreeDrag(handle, frame, id) {
        handle.addEventListener('pointerdown', function (e) {
            if (!e.isPrimary || e.button !== 0) {
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            var container = $('div.page-container');
            if (!container) {
                return;
            }
            var cr = container.getBoundingClientRect();
            var fr = frame.getBoundingClientRect();
            if (!cr.width) {
                return;
            }
            var grabDX = e.clientX - fr.left;
            var grabDY = e.clientY - fr.top;
            /* bring to front, remembered in the layout */
            freeTopZ += 1;
            frame.style.zIndex = freeTopZ;
            var moved = false;
            function onMove(ev) {
                if (ev.pointerId !== e.pointerId) {
                    return;
                }
                var c = container.getBoundingClientRect();
                if (!c.width) {
                    return;
                }
                var w = frame.getBoundingClientRect().width / c.width * 100;
                var left = (ev.clientX - grabDX - c.left) / c.width * 100;
                left = Math.max(0, Math.min(Math.max(0, 100 - w), left));
                var top = Math.max(0, ev.clientY - grabDY - c.top);
                frame.style.left = Math.round(left * 10) / 10 + '%';
                frame.style.top = Math.round(top) + 'px';
                moved = true;
                updateFreeHeight();
            }
            function onUp(ev) {
                if (ev.pointerId !== e.pointerId) {
                    return;
                }
                document.removeEventListener('pointermove', onMove);
                document.removeEventListener('pointerup', onUp);
                document.removeEventListener('pointercancel', onUp);
                if (moved) {
                    var st = layout[id] || (layout[id] = {});
                    st.left = parseFloat(frame.style.left) || 0;
                    st.top = parseFloat(frame.style.top) || 0;
                    st.z = freeTopZ;
                    persistLayout();
                }
                updateFreeHeight();
            }
            document.addEventListener('pointermove', onMove);
            document.addEventListener('pointerup', onUp);
            document.addEventListener('pointercancel', onUp);
        });
    }

    /* Wrap the page's own prefs functions so `camera_sizes` rides the
     * normal server-side prefs round-trip. If those functions do not
     * exist (old version), sizes live in localStorage only. */
    function wrapPrefs() {
        if (typeof window.prefsUi2Dict === 'function' && !window.prefsUi2Dict._gridWrapped) {
            var origToDict = window.prefsUi2Dict;
            var wrappedToDict = function () {
                var dict = origToDict();
                dict['camera_sizes'] = sizes;
                dict['camera_layout'] = layout;
                dict['grid_free_mode'] = freeMode;
                return dict;
            };
            wrappedToDict._gridWrapped = true;
            window.prefsUi2Dict = wrappedToDict;
        }
        if (typeof window.dict2PrefsUi === 'function' && !window.dict2PrefsUi._gridWrapped) {
            var origFromDict = window.dict2PrefsUi;
            var wrappedFromDict = function (dict) {
                origFromDict(dict);
                if (dict && dict['camera_sizes'] && typeof dict['camera_sizes'] === 'object') {
                    sizes = dict['camera_sizes'];
                    saveLocalSizes();
                    applySizes();
                }
                if (dict && dict['camera_layout'] && typeof dict['camera_layout'] === 'object') {
                    layout = dict['camera_layout'];
                    saveLocalLayout();
                }
                if (dict && typeof dict['grid_free_mode'] === 'boolean') {
                    freeMode = dict['grid_free_mode'];
                    document.body.classList.toggle('grid-free', freeMode);
                    saveLocalFree();
                    var fb = document.getElementById('gridFreeBtn');
                    if (fb) {
                        fb.classList.toggle('active', freeMode);
                    }
                }
                if (freeMode) {
                    applyFreeToAll();
                }
            };
            wrappedFromDict._gridWrapped = true;
            window.dict2PrefsUi = wrappedFromDict;
        }
    }

    /* ── Inset picture-in-picture ───────────────────────────────────
     * The P button on a frame adds a small live inset of ANOTHER camera
     * INSIDE that frame (the host). The inset drags anywhere within
     * the host and resizes by its corner handle, both clamped to the
     * host's bounds. It has NO title bar: the video fills the inset,
     * and the camera dropdown + close only appear as a strip over
     * the top while hovering, or after tapping (tap again hides).
     * One inset per host; P again removes it. State is kept in memory
     * so insets are re-created when motionEye rebuilds the frames. */

    function insetSourceFrames(hostId) {
        return getFrames().filter(function (f) {
            return frameId(f) !== hostId;
        });
    }

    function setInsetCamera(inset, hostId, cameraId) {
        var frame = document.getElementById('camera' + cameraId);
        var img = inset.querySelector('.grid-inset-img');
        if (!frame) {
            inset.querySelector('.grid-inset-name').textContent = 'Camera ' + cameraId;
            img.removeAttribute('src');
            return;
        }
        var src = frameStreamSrc(frame);
        if (src) {
            img.setAttribute('src', src);
        }
        inset.querySelector('.grid-inset-name').textContent = frameName(frame);
        var select = inset.querySelector('.grid-inset-select');
        if (select.value !== cameraId) {
            select.value = cameraId;
        }
    }

    function rebuildInsetSelect(inset, hostId) {
        var select = inset.querySelector('.grid-inset-select');
        var current = select.value;
        select.innerHTML = '';
        insetSourceFrames(hostId).forEach(function (frame) {
            var opt = document.createElement('option');
            opt.value = frameId(frame);
            opt.textContent = frameName(frame);
            select.appendChild(opt);
        });
        if (current) {
            select.value = current;
        }
    }

    function saveInsetState(inset, hostId) {
        var st = insets[hostId] || (insets[hostId] = {});
        st.cameraId = inset.querySelector('.grid-inset-select').value;
        /* only left/top-anchored insets have a stored position; a
         * never-dragged inset re-appears bottom-right by default */
        if (inset.style.left) {
            st.left = parseFloat(inset.style.left) || 0;
            st.top = parseFloat(inset.style.top) || 0;
        }
        if (inset.style.width) {
            st.width = parseFloat(inset.style.width) || 0;
        }
    }

    function clampInsetToHost(inset, host) {
        var hr = host.getBoundingClientRect();
        var ir = inset.getBoundingClientRect();
        var left = inset.style.left ? (parseFloat(inset.style.left) || 0) : (hr.width - ir.width - 8);
        var top = inset.style.top ? (parseFloat(inset.style.top) || 0) : (hr.height - ir.height - 8);
        left = Math.max(0, Math.min(Math.max(0, hr.width - ir.width), left));
        top = Math.max(0, Math.min(Math.max(0, hr.height - ir.height), top));
        inset.style.left = left + 'px';
        inset.style.top = top + 'px';
        inset.style.right = 'auto';
        inset.style.bottom = 'auto';
    }

    function addInsetDrag(inset, host, hostId) {
        inset.addEventListener('pointerdown', function (e) {
            if (!e.isPrimary || e.button !== 0) {
                return;
            }
            var tag = e.target.tagName;
            if (tag === 'SELECT' || tag === 'BUTTON' || tag === 'OPTION') {
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            /* convert any right/bottom anchoring to left/top first */
            var hr = host.getBoundingClientRect();
            var ir = inset.getBoundingClientRect();
            var startLeft = ir.left - hr.left;
            var startTop = ir.top - hr.top;
            inset.style.left = startLeft + 'px';
            inset.style.top = startTop + 'px';
            inset.style.right = 'auto';
            inset.style.bottom = 'auto';
            var startX = e.clientX;
            var startY = e.clientY;
            var moved = false;
            function onMove(ev) {
                if (ev.pointerId !== e.pointerId) {
                    return;
                }
                if (Math.abs(ev.clientX - startX) > 5 || Math.abs(ev.clientY - startY) > 5) {
                    moved = true;
                }
                var w = inset.getBoundingClientRect().width;
                var h = inset.getBoundingClientRect().height;
                var hw = host.getBoundingClientRect().width;
                var hh = host.getBoundingClientRect().height;
                inset.style.left = Math.max(0, Math.min(Math.max(0, hw - w), startLeft + (ev.clientX - startX))) + 'px';
                inset.style.top = Math.max(0, Math.min(Math.max(0, hh - h), startTop + (ev.clientY - startY))) + 'px';
            }
            function onUp(ev) {
                if (ev.pointerId !== e.pointerId) {
                    return;
                }
                document.removeEventListener('pointermove', onMove);
                document.removeEventListener('pointerup', onUp);
                document.removeEventListener('pointercancel', onUp);
                /* a tap (no drag) toggles the control strip — the
                 * only way to reach the dropdown/close on touch,
                 * where there is no hover */
                if (!moved) {
                    inset.classList.toggle('show-controls');
                }
                saveInsetState(inset, hostId);
            }
            document.addEventListener('pointermove', onMove);
            document.addEventListener('pointerup', onUp);
            document.addEventListener('pointercancel', onUp);
        });
    }

    function addInsetResize(handle, inset, host, hostId) {
        handle.addEventListener('pointerdown', function (e) {
            if (!e.isPrimary || e.button !== 0) {
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            /* anchor to left/top so width changes grow right/down */
            var hr = host.getBoundingClientRect();
            var ir = inset.getBoundingClientRect();
            inset.style.left = (ir.left - hr.left) + 'px';
            inset.style.top = (ir.top - hr.top) + 'px';
            inset.style.right = 'auto';
            inset.style.bottom = 'auto';
            var startW = ir.width;
            var startX = e.clientX;
            function onMove(ev) {
                if (ev.pointerId !== e.pointerId) {
                    return;
                }
                var hw = host.getBoundingClientRect().width;
                var hh = host.getBoundingClientRect().height;
                var left = parseFloat(inset.style.left) || 0;
                var top = parseFloat(inset.style.top) || 0;
                var maxW = Math.max(120, hw - left);
                var newW = Math.max(120, Math.min(maxW, startW + (ev.clientX - startX)));
                inset.style.width = newW + 'px';
                /* keep it inside vertically too: shrink until the
                 * bottom fits (one correction pass is enough, since
                 * height scales with width) */
                var r = inset.getBoundingClientRect();
                if (top + r.height > hh) {
                    var overflow = top + r.height - hh;
                    inset.style.width = Math.max(120, newW - overflow * (r.width / Math.max(1, r.height))) + 'px';
                }
            }
            function onUp(ev) {
                if (ev.pointerId !== e.pointerId) {
                    return;
                }
                document.removeEventListener('pointermove', onMove);
                document.removeEventListener('pointerup', onUp);
                document.removeEventListener('pointercancel', onUp);
                saveInsetState(inset, hostId);
            }
            document.addEventListener('pointermove', onMove);
            document.addEventListener('pointerup', onUp);
            document.addEventListener('pointercancel', onUp);
        });
    }

    function createInset(host, hostId, state) {
        var sources = insetSourceFrames(hostId);
        if (!sources.length) {
            return null;
        }
        var inset = document.createElement('div');
        inset.className = 'grid-inset';
        inset.innerHTML =
            '<div class="grid-inset-header">' +
                '<span class="grid-inset-name"></span>' +
                '<select class="grid-inset-select"></select>' +
                '<button type="button" class="grid-inset-close" title="Close picture-in-picture">✕</button>' +
            '</div>' +
            '<img class="grid-inset-img" alt="" draggable="false">' +
            '<div class="grid-inset-resize" title="Drag to resize inside this camera">⤢</div>';
        /* default: bottom-right of the host, ~30% of its width */
        inset.style.right = '8px';
        inset.style.bottom = '8px';
        host.appendChild(inset);
        rebuildInsetSelect(inset, hostId);
        var cameraId = (state && state.cameraId) || frameId(sources[0]);
        if (inset.querySelector('.grid-inset-select').value !== cameraId) {
            inset.querySelector('.grid-inset-select').value = cameraId;
        }
        setInsetCamera(inset, hostId, cameraId);
        var hostRect = host.getBoundingClientRect();
        inset.style.width = Math.max(120, Math.round(hostRect.width * 0.3)) + 'px';
        if (state && state.width) {
            inset.style.width = Math.max(120, state.width) + 'px';
        }
        if (state && typeof state.left === 'number') {
            inset.style.left = state.left + 'px';
            inset.style.top = state.top + 'px';
            inset.style.right = 'auto';
            inset.style.bottom = 'auto';
            clampInsetToHost(inset, host);
        }
        inset.querySelector('.grid-inset-select').addEventListener('change', function () {
            setInsetCamera(inset, hostId, this.value);
            saveInsetState(inset, hostId);
        });
        inset.querySelector('.grid-inset-close').addEventListener('click', function (ev) {
            ev.stopPropagation();
            removeInset(host);
        });
        addInsetDrag(inset, host, hostId);
        addInsetResize(inset.querySelector('.grid-inset-resize'), inset, host, hostId);
        saveInsetState(inset, hostId);
        return inset;
    }

    function removeInset(host) {
        var inset = host.querySelector('.grid-inset');
        if (inset) {
            inset.remove();
        }
        delete insets[frameId(host)];
    }

    function toggleInset(hostId) {
        var host = document.getElementById('camera' + hostId);
        if (!host) {
            return;
        }
        if (host.querySelector('.grid-inset')) {
            removeInset(host);
            return;
        }
        createInset(host, hostId, insets[hostId]);
    }

    function restoreInsets() {
        Object.keys(insets).forEach(function (hostId) {
            var host = document.getElementById('camera' + hostId);
            if (host && !host.querySelector('.grid-inset')) {
                createInset(host, hostId, insets[hostId]);
            }
        });
    }

    /* ── Reorder: upstream handles always on, fallback drag ─────── */

    function detectUpstreamReorder() {
        if (upstreamReorder !== null) {
            return upstreamReorder;
        }
        upstreamReorder = !!(
            document.querySelector('.move-camera') &&
            typeof window.cameraOrder !== 'undefined' &&
            typeof window.reorderCameraFrames === 'function'
        );
        return upstreamReorder;
    }

    function enableUpstreamReorder() {
        var sw = document.getElementById('cameraOrderControlsSwitch');
        if (!sw) {
            return;
        }
        if (window.jQuery) {
            window.jQuery(sw).prop('checked', true).trigger('change');
        } else if (!sw.checked) {
            sw.checked = true;
            sw.dispatchEvent(new Event('change', {bubbles: true}));
        }
    }

    function loadLocalOrder() {
        try {
            var raw = window.localStorage.getItem(LS_ORDER);
            return raw ? JSON.parse(raw) : [];
        } catch (e) {
            return [];
        }
    }

    function saveLocalOrder() {
        try {
            var ids = getFrames().map(function (f) { return frameId(f); });
            window.localStorage.setItem(LS_ORDER, JSON.stringify(ids));
        } catch (e) { /* ignore */ }
    }

    function applyLocalOrder() {
        var order = loadLocalOrder();
        if (!order.length) {
            return;
        }
        var container = $('div.page-container');
        if (!container) {
            return;
        }
        var byId = {};
        var current = getFrames();
        current.forEach(function (f) { byId[frameId(f)] = f; });
        /* desired order: stored ids that still exist, then any new
         * frames (not yet stored) in their current relative order */
        var desired = [];
        order.forEach(function (id) {
            if (byId[id]) {
                desired.push(byId[id]);
            }
        });
        current.forEach(function (f) {
            if (desired.indexOf(f) < 0) {
                desired.push(f);
            }
        });
        /* only touch the DOM when the order actually differs — otherwise
         * the observer would re-fire on every pass forever */
        var differs = current.length !== desired.length;
        if (!differs) {
            for (var i = 0; i < current.length; i++) {
                if (current[i] !== desired[i]) {
                    differs = true;
                    break;
                }
            }
        }
        if (!differs) {
            return;
        }
        desired.forEach(function (f) {
            container.appendChild(f);
        });
    }

    function addFallbackDrag(frame) {
        var handle = document.createElement('div');
        handle.className = 'button icon mouse-effect grid-drag-btn';
        handle.title = 'Drag to move around';
        handle.textContent = '⠿';
        frame.appendChild(handle);
        handle.addEventListener('pointerdown', function (e) {
            if (!e.isPrimary || e.button !== 0) {
                return;
            }
            var source = frame;
            var startRect = source.getBoundingClientRect();
            var baseRect = startRect;
            var lastX = e.clientX;
            var lastY = e.clientY;
            var moved = false;
            source.classList.add('dragging');
            e.preventDefault();
            function rebase() {
                source.style.transform = 'none';
                baseRect = source.getBoundingClientRect();
            }
            function onEvent(ev) {
                if (ev.pointerId !== e.pointerId) {
                    return;
                }
                if (ev.type === 'pointermove' || ev.type === 'pointerup') {
                    lastX = ev.clientX;
                    lastY = ev.clientY;
                    var under = document.elementFromPoint(ev.clientX, ev.clientY);
                    under = under && under.closest('.camera-frame');
                    if (under && under !== source && ev.type === 'pointerup') {
                        /* swap the two frames in the DOM */
                        var parent = source.parentElement;
                        var next = source.nextSibling === under ? source : source.nextSibling;
                        parent.insertBefore(source, under);
                        parent.insertBefore(under, next);
                        moved = true;
                    }
                    if (ev.type === 'pointermove') {
                        source.style.transform = 'translate(' +
                            (startRect.left + (lastX - e.clientX) - baseRect.left) + 'px, ' +
                            (startRect.top + (lastY - e.clientY) - baseRect.top) + 'px)';
                    }
                }
                if (ev.type === 'pointermove') {
                    return;
                }
                document.removeEventListener('pointermove', onEvent);
                document.removeEventListener('pointerup', onEvent);
                document.removeEventListener('pointercancel', onEvent);
                source.classList.remove('dragging');
                source.style.transform = '';
                if (moved) {
                    saveLocalOrder();
                }
            }
            document.addEventListener('pointermove', onEvent);
            document.addEventListener('pointerup', onEvent);
            document.addEventListener('pointercancel', onEvent);
        });
    }

    /* ── Per-frame buttons ──────────────────────────────────────── */

    function enhanceFrames() {
        var frames = getFrames();
        var hasUpstream = frames.length > 0 && detectUpstreamReorder();
        frames.forEach(function (frame) {
            if (frame.dataset.gridEnhanced) {
                return;
            }
            frame.dataset.gridEnhanced = '1';
            var id = frameId(frame);

            var sizeBtn = document.createElement('div');
            sizeBtn.className = 'grid-size-btn';
            sizeBtn.addEventListener('click', function (ev) {
                ev.stopPropagation();
                cycleSize(id);
            });
            frame.appendChild(sizeBtn);

            var pipBtn = document.createElement('div');
            pipBtn.className = 'grid-pip-btn';
            pipBtn.textContent = 'P';
            pipBtn.title = 'Picture-in-picture inside this camera';
            pipBtn.addEventListener('click', function (ev) {
                ev.stopPropagation();
                toggleInset(id);
            });
            frame.appendChild(pipBtn);

            var resizeHandle = document.createElement('div');
            resizeHandle.className = 'grid-resize-handle';
            resizeHandle.textContent = '⤢';
            resizeHandle.title = 'Drag the corner to resize freely (width % of the row)';
            addResizeDrag(resizeHandle, frame, id);
            frame.appendChild(resizeHandle);

            var freeHandle = document.createElement('div');
            freeHandle.className = 'grid-free-handle';
            freeHandle.textContent = '✥';
            freeHandle.title = 'Drag to move this camera anywhere (free layout)';
            addFreeDrag(freeHandle, frame, id);
            frame.appendChild(freeHandle);

            if (!hasUpstream) {
                addFallbackDrag(frame);
            }
        });
        applySizes();
        if (hasUpstream) {
            enableUpstreamReorder();
        } else {
            applyLocalOrder();
        }
        restoreInsets();
        if (freeMode) {
            if (Object.keys(layout).length === 0) {
                convertFreeLayout();
            }
            applyFreeToAll();
        }
    }

    /* ── Chrome toggle button + auto-hide ─────────────────────────
     * State: two body classes. grid-chrome-hidden hides the header
     * and footer (and drops the grid padding so the video covers the
     * freed space). grid-idle hides the circle button and all
     * per-frame buttons (size, PiP, drag, resize) so nothing sits on
     * the video while you watch.
     *   - mouse move / tap: show icon + frame buttons, restart timer
     *     (the header itself is never revealed by mouse movement —
     *     only the circle button toggles it, by design).
     *   - circle click: toggle the header, restart timer.
     *   - 4s idle: hide header + footer + icon + frame buttons.
     *   - settings/modal open: nothing hides; re-checked each timer. */

    var hideTimer = null;

    function chromeGuard() {
        /* motionEye tracks dialogs by visibility, not by container
         * children: stacked dialogs hide previous children instead
         * of removing them, so a children-only check can stick on
         * forever and block hiding entirely. Match motionEye's own
         * signal: a dialog counts as open only while its container
         * (or the dimming glass) is actually displayed. */
        if (document.querySelector('div.settings.open')) {
            return true;
        }
        var mc = document.querySelector('div.modal-container');
        if (mc && mc.children.length > 0 && window.getComputedStyle(mc).display !== 'none') {
            return true;
        }
        var glass = document.querySelector('div.modal-glass');
        if (glass && window.getComputedStyle(glass).display !== 'none') {
            return true;
        }
        return false;
    }

    function showAll() {
        document.body.classList.remove('grid-chrome-hidden');
        document.body.classList.remove('grid-idle');
    }

    function scheduleHide() {
        if (hideTimer) {
            clearTimeout(hideTimer);
        }
        hideTimer = setTimeout(function () {
            if (chromeGuard()) {
                showAll();
                scheduleHide(); /* re-check after settings/modal close */
            } else {
                document.body.classList.add('grid-chrome-hidden');
                document.body.classList.add('grid-idle');
            }
        }, HIDE_IDLE_MS);
    }

    function onActivity() {
        if (chromeGuard()) {
            showAll();
            return;
        }
        document.body.classList.remove('grid-idle');
        scheduleHide();
    }

    /* The chrome bar holds the circle button and the Free toggle as
     * one unit. Drag it anywhere by its ⠿ grip (buttons keep their
     * own clicks); its position is remembered. It hides on idle
     * with everything else and returns on mouse move / tap. */
    function chromeBar() {
        var bar = document.getElementById('gridChromeBar');
        if (bar) {
            return bar;
        }
        bar = document.createElement('div');
        bar.id = 'gridChromeBar';

        var grip = document.createElement('span');
        grip.className = 'grid-bar-grip';
        grip.textContent = '⠿';
        grip.title = 'Drag to move this bar anywhere';
        bar.appendChild(grip);

        /* circle button (existing behavior) */
        var btn = document.createElement('div');
        btn.id = 'gridChromeBtn';
        btn.title = 'Show/hide header';
        /* letter fallback, replaced by the logo image when it loads */
        var letter = document.createElement('span');
        letter.textContent = 'M';
        btn.appendChild(letter);
        var logo = document.createElement('img');
        logo.alt = '';
        logo.onload = function () { letter.style.display = 'none'; };
        logo.onerror = function () { logo.remove(); };
        logo.src = (window.staticPath || 'static/') + 'img/motioneye-icon.svg';
        btn.appendChild(logo);
        btn.addEventListener('click', function (ev) {
            ev.stopPropagation();
            if (chromeGuard()) {
                showAll();
                return;
            }
            document.body.classList.toggle('grid-chrome-hidden');
            document.body.classList.remove('grid-idle');
            scheduleHide();
        });
        bar.appendChild(btn);

        /* free-layout toggle */
        var freeBtn = document.createElement('button');
        freeBtn.type = 'button';
        freeBtn.id = 'gridFreeBtn';
        freeBtn.textContent = 'Free';
        freeBtn.title = 'Toggle free layout: drag frames anywhere';
        freeBtn.addEventListener('click', function (ev) {
            ev.stopPropagation();
            setFreeMode(!freeMode, true);
            persistFreeMode();
        });
        if (freeMode) {
            freeBtn.classList.add('active');
        }
        bar.appendChild(freeBtn);

        document.body.appendChild(bar);

        /* restore saved bar position, else it stays top-center via CSS */
        try {
            var raw = window.localStorage.getItem(LS_BAR_POS);
            if (raw) {
                var pos = JSON.parse(raw);
                if (typeof pos.left === 'number' && typeof pos.top === 'number') {
                    bar.style.left = pos.left + 'px';
                    bar.style.top = pos.top + 'px';
                    bar.style.transform = 'none';
                }
            }
        } catch (e) { /* default position */ }

        /* drag the bar by its grip */
        grip.addEventListener('pointerdown', function (e) {
            if (!e.isPrimary || e.button !== 0) {
                return;
            }
            e.preventDefault();
            var rect = bar.getBoundingClientRect();
            bar.style.left = rect.left + 'px';
            bar.style.top = rect.top + 'px';
            bar.style.transform = 'none';
            var dx = e.clientX - rect.left;
            var dy = e.clientY - rect.top;
            function onMove(ev) {
                if (ev.pointerId !== e.pointerId) {
                    return;
                }
                var w = bar.getBoundingClientRect().width;
                var h = bar.getBoundingClientRect().height;
                bar.style.left = Math.max(0, Math.min(window.innerWidth - w, ev.clientX - dx)) + 'px';
                bar.style.top = Math.max(0, Math.min(window.innerHeight - h, ev.clientY - dy)) + 'px';
            }
            function onUp(ev) {
                if (ev.pointerId !== e.pointerId) {
                    return;
                }
                document.removeEventListener('pointermove', onMove);
                document.removeEventListener('pointerup', onUp);
                document.removeEventListener('pointercancel', onUp);
                try {
                    window.localStorage.setItem(LS_BAR_POS, JSON.stringify({
                        left: parseFloat(bar.style.left) || 0,
                        top: parseFloat(bar.style.top) || 0
                    }));
                } catch (e) { /* ignore */ }
            }
            document.addEventListener('pointermove', onMove);
            document.addEventListener('pointerup', onUp);
            document.addEventListener('pointercancel', onUp);
        });
        return bar;
    }

    function initAutoHide() {
        chromeBar();
        document.addEventListener('mousemove', onActivity);
        document.addEventListener('touchstart', onActivity, {passive: true});
        window.addEventListener('resize', function () {
            if (freeMode) {
                updateFreeHeight();
            }
        });
        scheduleHide();
    }

    /* ── Boot ───────────────────────────────────────────────────── */

    sizes = loadLocalSizes();
    layout = loadLocalLayout();
    freeMode = loadLocalFree();
    document.body.classList.toggle('grid-free', freeMode);
    wrapPrefs();

    var container = $('div.page-container');
    if (container) {
        enhanceFrames();
        /* frames are rebuilt whenever cameras change; re-enhance then */
        var observer = new MutationObserver(function (mutations) {
            for (var i = 0; i < mutations.length; i++) {
                if (mutations[i].type === 'childList') {
                    enhanceFrames();
                    break;
                }
            }
        });
        observer.observe(container, {childList: true});
    }

    initAutoHide();
})();
