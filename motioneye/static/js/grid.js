/* motionEye grid enhancements — overlay, loaded after main.js.
 *
 * Adds, without modifying any upstream file except main.html (two lines
 * to load this file and grid.css):
 *   1. Per-camera frame sizes: a button on every frame cycles
 *      normal -> tiny -> large -> normal. Tiny tiles are for cameras
 *      you just want to glance at (e.g. ESP32 cameras parked at the
 *      bottom of the grid); large tiles give an important camera two
 *      cells of width. Sizes persist server-side in the user's prefs
 *      (a `camera_sizes` key piggybacking on the page's own save/load
 *      functions) with a localStorage fallback on old versions.
 *   2. Inset picture-in-picture: the P button on a frame adds a small
 *      live inset of ANOTHER camera INSIDE that frame. The inset drags
 *      anywhere within the host frame and resizes by its corner
 *      handle, both clamped to the host's bounds, with a dropdown to
 *      switch it to another camera. Its title bar can be hidden (it
 *      otherwise covers part of the host's video); a tiny tab remains
 *      to bring the title back. One inset per host; pressing P again
 *      removes it. Insets survive motionEye rebuilding the frames.
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

    var sizes = {}; /* camera id -> 'tiny' | 'large' (normal = absent) */
    var insets = {}; /* hostId -> {cameraId, titleHidden, left, top, width} */
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
            if (sizes[id] === 'tiny') {
                frame.classList.add('grid-size-tiny');
            } else if (sizes[id] === 'large') {
                frame.classList.add('grid-size-large');
            }
            var btn = frame.querySelector('.grid-size-btn');
            if (btn) {
                var cur = sizes[id] || 'normal';
                btn.textContent = SIZE_LETTER[cur];
                btn.title = SIZE_TITLE[cur];
            }
        });
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

    /* Corner-drag resize: pulling a frame's bottom-right corner steps
     * it through tiny -> normal -> large (and back) as the pointer
     * travels, 60px per step, and the final size is saved on release.
     * Stepped sizes keep the frame inside the column grid; free pixel
     * widths would break the grid flow and not survive a column change. */
    var SIZE_ORDER = ['tiny', 'normal', 'large'];
    var RESIZE_STEP_PX = 60;

    function sizeIndex(size) {
        var idx = SIZE_ORDER.indexOf(size || 'normal');
        return idx < 0 ? 1 : idx;
    }

    function addResizeDrag(handle, frame, id) {
        handle.addEventListener('pointerdown', function (e) {
            if (!e.isPrimary || e.button !== 0) {
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            var rect = frame.getBoundingClientRect();
            var startDist = Math.hypot(e.clientX - rect.left, e.clientY - rect.top);
            var startIdx = sizeIndex(sizes[id] || 'normal');
            var appliedSteps = 0;
            var moved = false;
            function onMove(ev) {
                if (ev.pointerId !== e.pointerId) {
                    return;
                }
                var dist = Math.hypot(ev.clientX - rect.left, ev.clientY - rect.top);
                var steps = Math.trunc((dist - startDist) / RESIZE_STEP_PX);
                if (steps !== appliedSteps) {
                    appliedSteps = steps;
                    var idx = Math.max(0, Math.min(SIZE_ORDER.length - 1, startIdx + steps));
                    applySizeToMap(id, SIZE_ORDER[idx]);
                    moved = true;
                }
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
        var cur = sizes[id] || 'normal';
        var next = SIZE_CYCLE[(SIZE_CYCLE.indexOf(cur) + 1) % SIZE_CYCLE.length];
        setSize(id, next);
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
            };
            wrappedFromDict._gridWrapped = true;
            window.dict2PrefsUi = wrappedFromDict;
        }
    }

    /* ── Inset picture-in-picture ───────────────────────────────────
     * The P button on a frame adds a small live inset of ANOTHER camera
     * INSIDE that frame (the host). The inset drags anywhere within
     * the host and resizes by its corner handle, both clamped to the
     * host's bounds. Its title bar can be hidden (it otherwise covers
     * part of the host's video); a tiny tab remains to bring it back.
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
        st.titleHidden = inset.classList.contains('title-hidden');
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
            /* the tab restores the title, it does not drag */
            if (e.target.classList.contains('grid-inset-tab')) {
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
            function onMove(ev) {
                if (ev.pointerId !== e.pointerId) {
                    return;
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
                '<button type="button" class="grid-inset-hide" title="Hide title bar">—</button>' +
                '<button type="button" class="grid-inset-close" title="Close picture-in-picture">✕</button>' +
            '</div>' +
            '<div class="grid-inset-tab" title="Show title bar">≡</div>' +
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
        if (state && state.titleHidden) {
            inset.classList.add('title-hidden');
        }
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
        inset.querySelector('.grid-inset-hide').addEventListener('click', function (ev) {
            ev.stopPropagation();
            inset.classList.add('title-hidden');
            saveInsetState(inset, hostId);
        });
        inset.querySelector('.grid-inset-tab').addEventListener('click', function (ev) {
            ev.stopPropagation();
            inset.classList.remove('title-hidden');
            saveInsetState(inset, hostId);
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
            resizeHandle.title = 'Drag the corner to resize (tiny / normal / large)';
            addResizeDrag(resizeHandle, frame, id);
            frame.appendChild(resizeHandle);

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

    function chromeBtn() {
        var btn = document.getElementById('gridChromeBtn');
        if (btn) {
            return btn;
        }
        btn = document.createElement('div');
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
        document.body.appendChild(btn);
        return btn;
    }

    function initAutoHide() {
        chromeBtn();
        document.addEventListener('mousemove', onActivity);
        document.addEventListener('touchstart', onActivity, {passive: true});
        scheduleHide();
    }

    /* ── Boot ───────────────────────────────────────────────────── */

    sizes = loadLocalSizes();
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
