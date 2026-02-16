<!-- src/components/panes/Stream.vue -->
<template>
    <div
        class="stream-pane"
        :style="{ '--pane-fg': paneFg, '--panel-fg': panelFg }"
        @mouseenter="onPaneEnter"
        @mouseleave="onPaneLeave"
    >
        <div class="stream-advanced-hotspot">
            <button
                class="gear-btn"
                :aria-expanded="showControls ? 'true' : 'false'"
                aria-controls="stream-controls-panel"
                title="Show stream settings"
                @click="toggleControls"
            >
                ⚙️
            </button>
        </div>

        <transition name="slide-fade">
            <div v-show="showControls" id="stream-controls-panel" class="controls-panel">
                <div class="toolbar">
                    <div class="left">
                        <div class="controls">
                            <label class="checkbox panel panel-text">
                                <input type="checkbox" v-model="enabled" @change="onEnabledChange" />
                                <span>Show stream</span>
                            </label>

                            <label class="select panel-text">
                                <span>LEDs</span>
                                <select v-model="fpLedsPosition">
                                    <option value="top-left-h">Top left (horizontal)</option>
                                    <option value="top-left-v">Top left (vertical)</option>

                                    <option value="top-right-h">Top right (horizontal)</option>
                                    <option value="top-right-v">Top right (vertical)</option>

                                    <option value="bottom-right-h">Bottom right (horizontal)</option>
                                    <option value="bottom-right-v">Bottom right (vertical)</option>
                                </select>
                            </label>

                            <!-- Viewer-side fps cap (auto uses health metrics to keep stream live) -->
                            <label class="select panel-text">
                                <span>Viewer FPS</span>
                                <select v-model="fpsMode">
                                    <option value="auto">Auto</option>
                                    <option value="60">60</option>
                                    <option value="30">30</option>
                                    <option value="20">20</option>
                                    <option value="15">15</option>
                                    <option value="8">8</option>
                                    <option value="4">4</option>
                                    <option value="2">2</option>
                                </select>
                            </label>

                            <!-- Power/Reset overlay settings -->
                            <label class="select panel-text">
                                <span>Power/Reset</span>
                                <select v-model="fpButtonsPosition">
                                    <option value="bottom-left">Bottom left</option>
                                    <option value="bottom-right">Bottom right</option>
                                </select>
                            </label>

                            <label class="select panel-text">
                                <span>Visibility</span>
                                <select v-model="fpButtonsVisibility">
                                    <option value="always">Always visible</option>
                                    <option value="hover">Visible on mouse over</option>
                                    <option value="hidden">Not visible</option>
                                </select>
                            </label>

                            <label class="select panel-text">
                                <span>LED visibility</span>
                                <select v-model="fpLedsVisibility">
                                    <option value="always">Always visible</option>
                                    <option value="hover">Visible on mouse over</option>
                                    <option value="hidden">Not visible</option>
                                </select>
                            </label>
                        </div>
                    </div>
                    <div class="right"></div>
                </div>

                <!-- Mouse tuning panel -->
                <div class="mouse-panel">
                    <div class="mouse-header">
                        <button
                            class="section-toggle"
                            type="button"
                            :aria-expanded="mousePanelOpen ? 'true' : 'false'"
                            aria-controls="stream-mouse-panel-body"
                            @click="mousePanelOpen = !mousePanelOpen"
                        >
                            <span class="section-chev" :data-open="mousePanelOpen ? 'true' : 'false'">▾</span>
                            <span class="mouse-title">Mouse settings</span>
                        </button>

                        <div class="mouse-actions">
                            <button class="mouse-btn mouse-btn--secondary" type="button" @click="resetAllMouseToDefaults">
                                Reset all to defaults
                            </button>
                            <button class="mouse-btn" type="button" @click="applyMouseDeviceConfig">
                                Apply device tuning
                            </button>
                        </div>
                    </div>

                    <transition name="collapse">
                        <div v-show="mousePanelOpen" id="stream-mouse-panel-body">
                            <div class="mouse-subtitle">Client-side shaping (per browser)</div>

                            <div class="mouse-grid">
                                <div class="mouse-setting">
                                    <div class="mouse-setting-name">Send rate</div>
                                    <div class="mouse-setting-control">
                                        <div class="select panel-text">
                                            <select v-model="mouseSendRate">
                                                <option value="raf">RAF (monitor)</option>
                                                <option value="120">120</option>
                                                <option value="90">90</option>
                                                <option value="60">60</option>
                                                <option value="30">30</option>
                                                <option value="20">20</option>
                                                <option value="15">15</option>
                                            </select>
                                        </div>

                                        <button
                                            class="mouse-default-btn"
                                            type="button"
                                            :disabled="mouseSendRate === MOUSE_DEFAULTS.sendRate"
                                            @click="setDefaultMouseSendRate"
                                        >
                                            Default
                                        </button>
                                    </div>
                                    <div class="mouse-setting-desc">
                                        Caps how often this browser flushes queued mouse deltas. Lower values reduce WS load but can feel “chunky”.
                                        <span class="mouse-setting-default">Default: {{ labelForSendRate(MOUSE_DEFAULTS.sendRate) }}</span>
                                    </div>
                                </div>

                                <div class="mouse-setting">
                                    <div class="mouse-setting-name">Sensitivity</div>
                                    <div class="mouse-setting-control">
                                        <div class="input panel-text">
                                            <input
                                                type="number"
                                                inputmode="decimal"
                                                step="0.05"
                                                min="0.05"
                                                max="10"
                                                v-model.number="mouseSensitivity"
                                            />
                                        </div>

                                        <button
                                            class="mouse-default-btn"
                                            type="button"
                                            :disabled="mouseSensitivity === MOUSE_DEFAULTS.sensitivity"
                                            @click="setDefaultMouseSensitivity"
                                        >
                                            Default
                                        </button>
                                    </div>
                                    <div class="mouse-setting-desc">
                                        Multiplies pointer-lock deltas before smoothing/rounding. Higher = faster cursor; lower = slower.
                                        <span class="mouse-setting-default">Default: {{ MOUSE_DEFAULTS.sensitivity }}</span>
                                    </div>
                                </div>

                                <div class="mouse-setting">
                                    <div class="mouse-setting-name">Smoothing</div>
                                    <div class="mouse-setting-control">
                                        <div class="input panel-text">
                                            <input
                                                type="number"
                                                inputmode="decimal"
                                                step="0.05"
                                                min="0"
                                                max="0.95"
                                                v-model.number="mouseSmoothing"
                                            />
                                        </div>

                                        <button
                                            class="mouse-default-btn"
                                            type="button"
                                            :disabled="mouseSmoothing === MOUSE_DEFAULTS.smoothing"
                                            @click="setDefaultMouseSmoothing"
                                        >
                                            Default
                                        </button>
                                    </div>
                                    <div class="mouse-setting-desc">
                                        EMA smoothing factor (0 = none). Higher values reduce jitter but add “floatiness” and latency.
                                        <span class="mouse-setting-default">Default: {{ MOUSE_DEFAULTS.smoothing }}</span>
                                    </div>
                                </div>

                                <div class="mouse-setting">
                                    <div class="mouse-setting-name">Max delta/send</div>
                                    <div class="mouse-setting-control">
                                        <div class="input panel-text">
                                            <input
                                                type="number"
                                                inputmode="numeric"
                                                step="1"
                                                min="1"
                                                max="500"
                                                v-model.number="mouseMaxDeltaPerSend"
                                            />
                                        </div>

                                        <button
                                            class="mouse-default-btn"
                                            type="button"
                                            :disabled="mouseMaxDeltaPerSend === MOUSE_DEFAULTS.maxDeltaPerSend"
                                            @click="setDefaultMouseMaxDeltaPerSend"
                                        >
                                            Default
                                        </button>
                                    </div>
                                    <div class="mouse-setting-desc">
                                        Chunks large moves into smaller packets so you don’t get “spiky bursts” (especially with device gain/accel).
                                        <span class="mouse-setting-default">Default: {{ MOUSE_DEFAULTS.maxDeltaPerSend }}</span>
                                    </div>
                                </div>

                                <div class="mouse-setting">
                                    <div class="mouse-setting-name">Invert X</div>
                                    <div class="mouse-setting-control">
                                        <label class="checkbox panel panel-text">
                                            <input type="checkbox" v-model="mouseInvertX" />
                                            <span>Enabled</span>
                                        </label>

                                        <button
                                            class="mouse-default-btn"
                                            type="button"
                                            :disabled="mouseInvertX === MOUSE_DEFAULTS.invertX"
                                            @click="setDefaultMouseInvertX"
                                        >
                                            Default
                                        </button>
                                    </div>
                                    <div class="mouse-setting-desc">
                                        Flips horizontal direction before sensitivity/smoothing.
                                        <span class="mouse-setting-default">Default: {{ MOUSE_DEFAULTS.invertX ? 'On' : 'Off' }}</span>
                                    </div>
                                </div>

                                <div class="mouse-setting">
                                    <div class="mouse-setting-name">Invert Y</div>
                                    <div class="mouse-setting-control">
                                        <label class="checkbox panel panel-text">
                                            <input type="checkbox" v-model="mouseInvertY" />
                                            <span>Enabled</span>
                                        </label>

                                        <button
                                            class="mouse-default-btn"
                                            type="button"
                                            :disabled="mouseInvertY === MOUSE_DEFAULTS.invertY"
                                            @click="setDefaultMouseInvertY"
                                        >
                                            Default
                                        </button>
                                    </div>
                                    <div class="mouse-setting-desc">
                                        Flips vertical direction before sensitivity/smoothing.
                                        <span class="mouse-setting-default">Default: {{ MOUSE_DEFAULTS.invertY ? 'On' : 'Off' }}</span>
                                    </div>
                                </div>
                            </div>

                            <div class="mouse-subtitle">Device tuning (applies to Arduino/service)</div>
                            <div class="mouse-actions-note">
                                These settings are sent via <code>mouse.config</code> when you click <b>Apply device tuning</b>,
                                and also automatically at capture start if auto-apply is enabled.
                            </div>

                            <div class="mouse-grid">
                                <div class="mouse-setting">
                                    <div class="mouse-setting-name">Auto-apply device tuning on capture</div>
                                    <div class="mouse-setting-control">
                                        <label class="checkbox panel panel-text">
                                            <input type="checkbox" v-model="mouseDeviceAutoApply" />
                                            <span>Enabled</span>
                                        </label>

                                        <button
                                            class="mouse-default-btn"
                                            type="button"
                                            :disabled="mouseDeviceAutoApply === MOUSE_DEFAULTS.deviceAutoApply"
                                            @click="setDefaultMouseDeviceAutoApply"
                                        >
                                            Default
                                        </button>
                                    </div>
                                    <div class="mouse-setting-desc">
                                        If enabled, the pane sends a device config automatically when pointer-lock capture begins.
                                        <span class="mouse-setting-default">Default: {{ MOUSE_DEFAULTS.deviceAutoApply ? 'On' : 'Off' }}</span>
                                    </div>
                                </div>

                                <div class="mouse-setting">
                                    <div class="mouse-setting-name">Mode</div>
                                    <div class="mouse-setting-control">
                                        <div class="select panel-text">
                                            <select v-model="mouseDeviceMode">
                                                <option value="relative-gain">Relative gain</option>
                                                <option value="relative-accel">Relative accel</option>
                                                <option value="absolute">Absolute (requires absolute input)</option>
                                            </select>
                                        </div>

                                        <button
                                            class="mouse-default-btn"
                                            type="button"
                                            :disabled="mouseDeviceMode === MOUSE_DEFAULTS.deviceMode"
                                            @click="setDefaultMouseDeviceMode"
                                        >
                                            Default
                                        </button>
                                    </div>
                                    <div class="mouse-setting-desc">
                                        Controls how the device interprets deltas. This pane sends <code>mouse.move.relative</code> from pointer lock, so relative modes apply.
                                        <span class="mouse-setting-default">Default: {{ labelForDeviceMode(MOUSE_DEFAULTS.deviceMode) }}</span>
                                    </div>
                                </div>

                                <div class="mouse-setting">
                                    <div class="mouse-setting-name">Gain</div>
                                    <div class="mouse-setting-control">
                                        <div class="input panel-text">
                                            <input type="number" step="1" min="1" max="200" v-model.number="mouseDeviceGain" />
                                        </div>

                                        <button
                                            class="mouse-default-btn"
                                            type="button"
                                            :disabled="mouseDeviceGain === MOUSE_DEFAULTS.deviceGain"
                                            @click="setDefaultMouseDeviceGain"
                                        >
                                            Default
                                        </button>
                                    </div>
                                    <div class="mouse-setting-desc">
                                        Scales deltas on the device. Higher values amplify movement (and any batching artifacts).
                                        <span class="mouse-setting-default">Default: {{ MOUSE_DEFAULTS.deviceGain }}</span>
                                    </div>
                                </div>

                                <div class="mouse-setting">
                                    <div class="mouse-setting-name">Accel enabled</div>
                                    <div class="mouse-setting-control">
                                        <label class="checkbox panel panel-text">
                                            <input type="checkbox" v-model="mouseDeviceAccelEnabled" />
                                            <span>Enabled</span>
                                        </label>

                                        <button
                                            class="mouse-default-btn"
                                            type="button"
                                            :disabled="mouseDeviceAccelEnabled === MOUSE_DEFAULTS.deviceAccelEnabled"
                                            @click="setDefaultMouseDeviceAccelEnabled"
                                        >
                                            Default
                                        </button>
                                    </div>
                                    <div class="mouse-setting-desc">
                                        Enables velocity-based gain ramp on the device. Useful for “flick” acceleration; can feel like snapping if combined with batching/gain.
                                        <span class="mouse-setting-default">Default: {{ MOUSE_DEFAULTS.deviceAccelEnabled ? 'On' : 'Off' }}</span>
                                    </div>
                                </div>

                                <div class="mouse-setting">
                                    <div class="mouse-setting-name">Accel base</div>
                                    <div class="mouse-setting-control">
                                        <div class="input panel-text">
                                            <input type="number" step="1" min="1" max="200" v-model.number="mouseDeviceAccelBaseGain" />
                                        </div>

                                        <button
                                            class="mouse-default-btn"
                                            type="button"
                                            :disabled="mouseDeviceAccelBaseGain === MOUSE_DEFAULTS.deviceAccelBaseGain"
                                            @click="setDefaultMouseDeviceAccelBaseGain"
                                        >
                                            Default
                                        </button>
                                    </div>
                                    <div class="mouse-setting-desc">
                                        Base gain when accel is enabled (at low velocity).
                                        <span class="mouse-setting-default">Default: {{ MOUSE_DEFAULTS.deviceAccelBaseGain }}</span>
                                    </div>
                                </div>

                                <div class="mouse-setting">
                                    <div class="mouse-setting-name">Accel max</div>
                                    <div class="mouse-setting-control">
                                        <div class="input panel-text">
                                            <input type="number" step="1" min="1" max="500" v-model.number="mouseDeviceAccelMaxGain" />
                                        </div>

                                        <button
                                            class="mouse-default-btn"
                                            type="button"
                                            :disabled="mouseDeviceAccelMaxGain === MOUSE_DEFAULTS.deviceAccelMaxGain"
                                            @click="setDefaultMouseDeviceAccelMaxGain"
                                        >
                                            Default
                                        </button>
                                    </div>
                                    <div class="mouse-setting-desc">
                                        Max gain when accel is enabled (at/above “Vel for max”).
                                        <span class="mouse-setting-default">Default: {{ MOUSE_DEFAULTS.deviceAccelMaxGain }}</span>
                                    </div>
                                </div>

                                <div class="mouse-setting">
                                    <div class="mouse-setting-name">Vel for max</div>
                                    <div class="mouse-setting-control">
                                        <div class="input panel-text">
                                            <input
                                                type="number"
                                                step="10"
                                                min="10"
                                                max="50000"
                                                v-model.number="mouseDeviceAccelVelForMax"
                                            />
                                        </div>

                                        <button
                                            class="mouse-default-btn"
                                            type="button"
                                            :disabled="mouseDeviceAccelVelForMax === MOUSE_DEFAULTS.deviceAccelVelForMax"
                                            @click="setDefaultMouseDeviceAccelVelForMax"
                                        >
                                            Default
                                        </button>
                                    </div>
                                    <div class="mouse-setting-desc">
                                        Velocity threshold (px/sec) for reaching max accel gain.
                                        <span class="mouse-setting-default">Default: {{ MOUSE_DEFAULTS.deviceAccelVelForMax }}</span>
                                    </div>
                                </div>

                                <div class="mouse-setting">
                                    <div class="mouse-setting-name">Abs grid</div>
                                    <div class="mouse-setting-control">
                                        <div class="select panel-text">
                                            <select v-model="mouseDeviceGridMode">
                                                <option value="auto">Auto</option>
                                                <option value="fixed">Fixed</option>
                                            </select>
                                        </div>

                                        <button
                                            class="mouse-default-btn"
                                            type="button"
                                            :disabled="mouseDeviceGridMode === MOUSE_DEFAULTS.deviceGridMode"
                                            @click="setDefaultMouseDeviceGridMode"
                                        >
                                            Default
                                        </button>
                                    </div>
                                    <div class="mouse-setting-desc">
                                        Only relevant for <code>absolute</code> mode inputs. Fixed grid defines the absolute coordinate space (W/H).
                                        <span class="mouse-setting-default">Default: {{ labelForGridMode(MOUSE_DEFAULTS.deviceGridMode) }}</span>
                                    </div>
                                </div>

                                <div class="mouse-setting" :data-disabled="mouseDeviceGridMode !== 'fixed' ? 'true' : 'false'">
                                    <div class="mouse-setting-name">Grid W</div>
                                    <div class="mouse-setting-control">
                                        <div class="input panel-text">
                                            <input
                                                :disabled="mouseDeviceGridMode !== 'fixed'"
                                                type="number"
                                                step="1"
                                                min="1"
                                                max="10000"
                                                v-model.number="mouseDeviceGridW"
                                            />
                                        </div>

                                        <button
                                            class="mouse-default-btn"
                                            type="button"
                                            :disabled="mouseDeviceGridMode !== 'fixed' || mouseDeviceGridW === MOUSE_DEFAULTS.deviceGridW"
                                            @click="setDefaultMouseDeviceGridW"
                                        >
                                            Default
                                        </button>
                                    </div>
                                    <div class="mouse-setting-desc">
                                        Absolute grid width (only when Abs grid = Fixed).
                                        <span class="mouse-setting-default">Default: {{ MOUSE_DEFAULTS.deviceGridW }}</span>
                                    </div>
                                </div>

                                <div class="mouse-setting" :data-disabled="mouseDeviceGridMode !== 'fixed' ? 'true' : 'false'">
                                    <div class="mouse-setting-name">Grid H</div>
                                    <div class="mouse-setting-control">
                                        <div class="input panel-text">
                                            <input
                                                :disabled="mouseDeviceGridMode !== 'fixed'"
                                                type="number"
                                                step="1"
                                                min="1"
                                                max="10000"
                                                v-model.number="mouseDeviceGridH"
                                            />
                                        </div>

                                        <button
                                            class="mouse-default-btn"
                                            type="button"
                                            :disabled="mouseDeviceGridMode !== 'fixed' || mouseDeviceGridH === MOUSE_DEFAULTS.deviceGridH"
                                            @click="setDefaultMouseDeviceGridH"
                                        >
                                            Default
                                        </button>
                                    </div>
                                    <div class="mouse-setting-desc">
                                        Absolute grid height (only when Abs grid = Fixed).
                                        <span class="mouse-setting-default">Default: {{ MOUSE_DEFAULTS.deviceGridH }}</span>
                                    </div>
                                </div>
                            </div>

                            <div class="mouse-note">
                                Quick notes:
                                <ul>
                                    <li>
                                        This pane uses pointer lock, so it sends <code>mouse.move.relative</code> deltas.
                                        <b>Absolute</b> mode only helps if another sender emits <code>mouse.move.absolute</code>.
                                    </li>
                                    <li>
                                        If you see “snapping”, it’s usually a combination of (a) client batching (send rate / max delta) and (b) device amplification (gain/accel).
                                    </li>
                                </ul>
                            </div>
                        </div>
                    </transition>
                </div>

                <div class="health-panel">
                    <div class="health-header">
                        <button
                            class="section-toggle"
                            type="button"
                            :aria-expanded="healthPanelOpen ? 'true' : 'false'"
                            aria-controls="stream-health-panel-body"
                            @click="healthPanelOpen = !healthPanelOpen"
                        >
                            <span class="section-chev" :data-open="healthPanelOpen ? 'true' : 'false'">▾</span>
                            <span class="health-title">Sidecar / Stream health</span>
                        </button>

                        <span class="health-meta">
                            <span v-if="healthLoading" class="health-pill health-pill--loading">
                                Loading…
                            </span>
                            <span v-else-if="health" class="health-pill health-pill--ok">
                                {{ health.status === 'ok' ? 'OK' : health.status }}
                            </span>
                            <span v-else-if="healthError" class="health-pill health-pill--error">
                                Error
                            </span>
                        </span>
                    </div>

                    <transition name="collapse">
                        <div v-show="healthPanelOpen" id="stream-health-panel-body">
                            <div v-if="healthError" class="health-error">⚠️ {{ healthError }}</div>

                            <div v-else-if="health" class="health-grid">
                                <div class="health-row">
                                    <span class="label">Service</span>
                                    <span class="value monospace">{{ health.service }}</span>
                                </div>

                                <div class="health-row">
                                    <span class="label">Uptime</span>
                                    <span class="value">
                                        {{ formattedUptime }}
                                    </span>
                                </div>

                                <div class="health-row">
                                    <span class="label">Capture</span>
                                    <span class="value">
                                        <span v-if="health.capture?.running">Running</span>
                                        <span v-else>Stopped</span>
                                        <span v-if="health.capture?.restartCount != null">
                                            · {{ health.capture.restartCount }} restart<span
                                                v-if="health.capture.restartCount !== 1"
                                                >s</span
                                            >
                                        </span>
                                    </span>
                                </div>

                                <div class="health-row">
                                    <span class="label">Viewer cap</span>
                                    <span class="value monospace">
                                        {{ viewerCapLabel }}
                                    </span>
                                </div>

                                <div class="health-row">
                                    <span class="label">Resyncs</span>
                                    <span class="value monospace">
                                        {{ resyncCount }}
                                    </span>
                                </div>

                                <div class="health-row">
                                    <span class="label">Capture age</span>
                                    <span class="value monospace" :data-age="captureAgeBucket">
                                        {{ formattedCaptureAge }}
                                    </span>
                                </div>

                                <div class="health-row">
                                    <span class="label">Backlog est</span>
                                    <span class="value monospace" :data-age="backlogBucket">
                                        {{ formattedBacklog }}
                                    </span>
                                </div>

                                <div class="health-row">
                                    <span class="label">Buffered</span>
                                    <span class="value monospace">
                                        {{ formattedBuffered }}
                                    </span>
                                </div>

                                <div class="health-row">
                                    <span class="label">Downstream</span>
                                    <span class="value monospace">
                                        {{ formattedDownstream }}
                                    </span>
                                </div>

                                <div class="health-row">
                                    <span class="label">Backpressure</span>
                                    <span class="value monospace">
                                        {{ formattedBackpressure }}
                                    </span>
                                </div>

                                <div class="health-row">
                                    <span class="label">Avg frame</span>
                                    <span class="value monospace">
                                        {{ formattedAvgFrame }}
                                    </span>
                                </div>

                                <div class="health-row">
                                    <span class="label">Health RTT</span>
                                    <span class="value monospace">
                                        {{ healthRttMs != null ? `${healthRttMs}ms` : '—' }}
                                    </span>
                                </div>

                                <div class="health-row">
                                    <span class="label">Frame</span>
                                    <span class="value monospace">
                                        {{ health.capture?.metrics?.frame ?? '—' }}
                                    </span>
                                </div>

                                <div class="health-row">
                                    <span class="label">FPS</span>
                                    <span class="value monospace">
                                        {{ health.capture?.metrics?.fps ?? '—' }}
                                    </span>
                                </div>

                                <div class="health-row">
                                    <span class="label">Quality</span>
                                    <span class="value monospace">
                                        {{ health.capture?.metrics?.quality ?? '—' }}
                                    </span>
                                </div>
                            </div>

                            <div v-else class="health-empty">No health data yet.</div>

                            <div v-if="health" class="health-note">
                                If Capture age stays low but Backlog est climbs, the stream path is backlogged
                                (decode/throughput), not capture.
                            </div>
                        </div>
                    </transition>
                </div>
            </div>
        </transition>

        <div class="viewport-stack">
            <div class="viewport" :data-bg="bgMode" :data-kb-available="canCapture ? 'true' : 'false'">
                <div v-if="enabled" class="viewport-inner">
                    <div
                        ref="captureRef"
                        class="kb-capture-layer"
                        tabindex="0"
                        role="button"
                        :aria-pressed="isCapturing ? 'true' : 'false'"
                        :data-capturing="isCapturing ? 'true' : 'false'"
                        :data-scale="scaleMode"
                        @mousedown.prevent="onCaptureMouseDown"
                        @mouseup.prevent="onCaptureMouseUp"
                        @mousemove.prevent="onCaptureMouseMove"
                        @wheel.prevent="onCaptureWheel"
                        @contextmenu.prevent
                        @focus="onFocusCapture"
                        @blur="onBlurCapture"
                        @keydown="onKeyDown"
                        @keyup="onKeyUp"
                    >
                        <div class="stream-frame" :data-scale="scaleMode" :style="streamFrameStyle">
                            <img
                                :key="reloadKey"
                                class="stream-img"
                                :data-scale="scaleMode"
                                :src="streamSrc"
                                alt="Test machine stream"
                                draggable="false"
                                @load="onStreamLoad"
                            />
                            <div class="stream-glow kb-glow" aria-hidden="true"></div>
                        </div>

                        <div v-if="scaleMode === 'native'" class="capture-glow kb-glow" aria-hidden="true"></div>

                        <div v-if="isCapturing" class="kb-overlay" aria-hidden="true">
                            <div class="kb-overlay-inner">
                                <span class="kb-hint">Press <b>Esc</b> to exit input capture</span>
                            </div>
                        </div>
                    </div>
                </div>

                <div v-else class="viewport-placeholder">
                    <span class="placeholder-text">Stream is hidden (use ⚙️ to show)</span>
                </div>

                <!-- Front panel LED indicators (overlay + position control: top-left / top-right) -->
                <div
                    v-show="fpLedsShouldShow"
                    class="frontpanel-leds frontpanel-leds--overlay"
                    :data-pos="fpLedsPosition"
                >
                    <span class="fp-led-badge" data-kind="power" :data-mode="fpPowerLedMode">
                        <span class="label">PWR</span>
                        <span class="dot" aria-hidden="true"></span>
                    </span>

                    <span class="fp-led-badge" data-kind="hdd" :data-mode="fpHddLedMode">
                        <span class="label">HDD</span>
                        <span class="dot" aria-hidden="true"></span>
                    </span>
                </div>

                <!-- Front panel controls: overlay + position control (bottom-left / bottom-right) -->
                <div
                    v-show="fpButtonsShouldShow && !isCapturing"
                    class="frontpanel-controls frontpanel-controls--overlay"
                    :data-pos="fpButtonsPosition"
                >
                    <button
                        class="fp-btn"
                        :data-held="powerHeldByClient ? 'true' : 'false'"
                        :disabled="!fpCanInteract"
                        @mousedown.prevent="onPowerHoldStart"
                        @mouseup.prevent="onPowerHoldEnd"
                        @mouseleave.prevent="onPowerHoldEnd"
                        @touchstart.prevent="onPowerHoldStart"
                        @touchend.prevent="onPowerHoldEnd"
                        @touchcancel.prevent="onPowerHoldEnd"
                    >
                        Power
                    </button>

                    <button
                        class="fp-btn"
                        :data-held="resetHeldByClient ? 'true' : 'false'"
                        :disabled="!fpCanInteract"
                        @mousedown.prevent="onResetHoldStart"
                        @mouseup.prevent="onResetHoldEnd"
                        @mouseleave.prevent="onResetHoldEnd"
                        @touchstart.prevent="onResetHoldStart"
                        @touchend.prevent="onResetHoldEnd"
                        @touchcancel.prevent="onResetHoldEnd"
                    >
                        Reset
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { getRealtimeClient } from '@/bootstrap'
import { useMirror } from '@/stores/mirror'

type Direction = 'row' | 'col'
type Constraints = {
    widthPx?: number | null
    heightPx?: number | null
    widthPct?: number | null
    heightPct?: number | null
}
type Appearance = {
    bg?: string | null
    mTop?: number | null
    mRight?: number | null
    mBottom?: number | null
    mLeft?: number | null
}
type PaneInfo = {
    id: string
    isRoot: boolean
    parentDir: Direction | null
    constraints: Constraints
    appearance: Appearance
    container: {
        constraints: Constraints | null
        direction: Direction | null
    }
}

type StreamFpsMode = 'auto' | '60' | '30' | '20' | '15' | '8' | '4' | '2'

type FrontPanelButtonsPosition = 'bottom-left' | 'bottom-right'
type FrontPanelButtonsVisibility = 'always' | 'hover' | 'hidden'

type FrontPanelLedsPosition =
    | 'top-left-h'
    | 'top-left-v'
    | 'top-right-h'
    | 'top-right-v'
    | 'bottom-right-h'
    | 'bottom-right-v'

type FrontPanelLedsVisibility = 'always' | 'hover' | 'hidden'
type FrontPanelLedMode = 'off' | 'on' | 'blink' | 'blink-fast' | 'pulse'

type MouseSendRateMode = 'raf' | '120' | '90' | '60' | '30' | '20' | '15'
type MouseDeviceMode = 'relative-gain' | 'relative-accel' | 'absolute'
type MouseGridMode = 'auto' | 'fixed'

type StreamPanePrefs = {
    prefsRev?: number

    enabled?: boolean
    scaleMode?: 'fit' | 'fill' | 'stretch' | 'native'
    bgMode?: 'black' | 'pane'
    fpsMode?: StreamFpsMode

    fpButtonsPosition?: FrontPanelButtonsPosition
    fpButtonsVisibility?: FrontPanelButtonsVisibility

    fpLedsPosition?: FrontPanelLedsPosition
    fpLedsVisibility?: FrontPanelLedsVisibility

    // client-side mouse tuning
    mouseSendRate?: MouseSendRateMode
    mouseSensitivity?: number
    mouseSmoothing?: number
    mouseMaxDeltaPerSend?: number
    mouseInvertX?: boolean
    mouseInvertY?: boolean

    // device-side tuning (mouse.config)
    mouseDeviceAutoApply?: boolean
    mouseDeviceMode?: MouseDeviceMode
    mouseDeviceGain?: number
    mouseDeviceAccelEnabled?: boolean
    mouseDeviceAccelBaseGain?: number
    mouseDeviceAccelMaxGain?: number
    mouseDeviceAccelVelForMax?: number
    mouseDeviceGridMode?: MouseGridMode
    mouseDeviceGridW?: number
    mouseDeviceGridH?: number

    // UI collapse state
    mousePanelOpen?: boolean
    healthPanelOpen?: boolean
}

function isObject(x: any): x is Record<string, unknown> {
    return x !== null && typeof x === 'object' && !Array.isArray(x)
}

const props = defineProps<{
    pane?: PaneInfo
    __streamPaneUi?: StreamPanePrefs
    __streamPaneProfileRev?: number
}>()

const STREAM_ENDPOINT = '/api/sidecar/stream'
const HEALTH_ENDPOINT = '/api/sidecar/health'

type SidecarStreamDiag = {
    clients: number
    lastFrameBytes: number
    avgFrameBytes: number | null
    backpressureEvents: number
    lastBackpressureTs: number | null
    maxClientBufferedBytes: number
    maxClientBufferedRatio: number
    downstreamBps: number | null
    estBacklogMs: number | null
    updatedAt: string | null
}

type SidecarHealthMetrics = {
    frame?: string
    fps?: string
    quality?: string
    time?: string
    size?: string
    bitrate?: string
}

type SidecarHealthCapture = {
    running: boolean
    lastFrameTs: number | null
    lastFrameAgeMs?: number | null
    lastError: string | null
    restartCount: number
    metrics?: SidecarHealthMetrics
    hasLastFrame: boolean
    streamDiag?: SidecarStreamDiag | null
}

type SidecarHealthEnv = {
    nodeEnv: string
    port: number
    host: string
    ffmpegArgsConfigured: boolean
    maxStreamClients: number
    recordingsRoot: string
    maxRecordings: number
}

type SidecarHealth = {
    service: string
    status: string
    timestamp: string
    uptimeSec: number
    hostname: string
    env: SidecarHealthEnv
    capture?: SidecarHealthCapture
    reasons: string[]
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
    if (!hex) return null
    const s = hex.trim().replace(/^#/, '')
    if (!/^[0-9a-fA-F]{6}$/.test(s)) return null
    const int = parseInt(s, 16)
    return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 }
}
function srgbToLinear(c: number): number {
    const x = c / 255
    return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
}
function relLuminance(hex: string): number {
    const rgb = hexToRgb(hex)
    if (!rgb) return 1
    const r = srgbToLinear(rgb.r)
    const g = srgbToLinear(rgb.g)
    const b = srgbToLinear(rgb.b)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function contrastRatio(l1: number, l2: number): number {
    const [L1, L2] = l1 >= l2 ? [l1, l2] : [l2, l1]
    return (L1 + 0.05) / (L2 + 0.05)
}

const paneFg = computed(() => {
    const bg = (props.pane?.appearance?.bg ?? '#ffffff') as string
    const Lbg = relLuminance(bg)
    const contrastWithWhite = contrastRatio(relLuminance('#ffffff'), Lbg)
    const contrastWithBlack = contrastRatio(relLuminance('#000000'), Lbg)
    return contrastWithWhite >= contrastWithBlack ? '#ffffff' : '#111111'
})

const panelFg = '#e6e6e6'

const showControls = ref(false)
const mousePanelOpen = ref(true)
const healthPanelOpen = ref(false)

const enabled = ref(true)
const scaleMode = ref<'fit' | 'fill' | 'stretch' | 'native'>('fit')
const bgMode = ref<'black' | 'pane'>('black')
const reloadKey = ref(0)

/* -------------------------------------------------------------------------- */
/*  Mouse settings (client + device)                                          */
/* -------------------------------------------------------------------------- */

const MOUSE_DEFAULTS = {
    // client-side shaping
    sendRate: '120' as MouseSendRateMode,
    sensitivity: 1.0,
    smoothing: 0.0,
    maxDeltaPerSend: 1,
    invertX: false,
    invertY: false,

    // device-side tuning
    deviceAutoApply: true,
    deviceMode: 'relative-gain' as MouseDeviceMode,
    deviceGain: 1,

    deviceAccelEnabled: false,
    deviceAccelBaseGain: 1,
    deviceAccelMaxGain: 1,
    deviceAccelVelForMax: 1000,

    deviceGridMode: 'auto' as MouseGridMode,
    deviceGridW: 1024,
    deviceGridH: 768,
} as const

function labelForSendRate(v: MouseSendRateMode): string {
    return v === 'raf' ? 'RAF (monitor)' : `${v}Hz`
}
function labelForDeviceMode(v: MouseDeviceMode): string {
    if (v === 'relative-gain') return 'Relative gain'
    if (v === 'relative-accel') return 'Relative accel'
    return 'Absolute'
}
function labelForGridMode(v: MouseGridMode): string {
    return v === 'fixed' ? 'Fixed' : 'Auto'
}

// Defaults tuned to reduce “micro-move batching” and avoid multi-pixel jumps.
const mouseSendRate = ref<MouseSendRateMode>(MOUSE_DEFAULTS.sendRate)
const mouseSensitivity = ref<number>(MOUSE_DEFAULTS.sensitivity)
const mouseSmoothing = ref<number>(MOUSE_DEFAULTS.smoothing)
const mouseMaxDeltaPerSend = ref<number>(MOUSE_DEFAULTS.maxDeltaPerSend)
const mouseInvertX = ref<boolean>(MOUSE_DEFAULTS.invertX)
const mouseInvertY = ref<boolean>(MOUSE_DEFAULTS.invertY)

// Device defaults: avoid amplifying the smallest integer deltas.
const mouseDeviceAutoApply = ref<boolean>(MOUSE_DEFAULTS.deviceAutoApply)
const mouseDeviceMode = ref<MouseDeviceMode>(MOUSE_DEFAULTS.deviceMode)
const mouseDeviceGain = ref<number>(MOUSE_DEFAULTS.deviceGain)

const mouseDeviceAccelEnabled = ref<boolean>(MOUSE_DEFAULTS.deviceAccelEnabled)
const mouseDeviceAccelBaseGain = ref<number>(MOUSE_DEFAULTS.deviceAccelBaseGain)
const mouseDeviceAccelMaxGain = ref<number>(MOUSE_DEFAULTS.deviceAccelMaxGain)
const mouseDeviceAccelVelForMax = ref<number>(MOUSE_DEFAULTS.deviceAccelVelForMax)

const mouseDeviceGridMode = ref<MouseGridMode>(MOUSE_DEFAULTS.deviceGridMode)
const mouseDeviceGridW = ref<number>(MOUSE_DEFAULTS.deviceGridW)
const mouseDeviceGridH = ref<number>(MOUSE_DEFAULTS.deviceGridH)

function setDefaultMouseSendRate() {
    mouseSendRate.value = MOUSE_DEFAULTS.sendRate
}
function setDefaultMouseSensitivity() {
    mouseSensitivity.value = MOUSE_DEFAULTS.sensitivity
}
function setDefaultMouseSmoothing() {
    mouseSmoothing.value = MOUSE_DEFAULTS.smoothing
}
function setDefaultMouseMaxDeltaPerSend() {
    mouseMaxDeltaPerSend.value = MOUSE_DEFAULTS.maxDeltaPerSend
}
function setDefaultMouseInvertX() {
    mouseInvertX.value = MOUSE_DEFAULTS.invertX
}
function setDefaultMouseInvertY() {
    mouseInvertY.value = MOUSE_DEFAULTS.invertY
}

function setDefaultMouseDeviceAutoApply() {
    mouseDeviceAutoApply.value = MOUSE_DEFAULTS.deviceAutoApply
}
function setDefaultMouseDeviceMode() {
    mouseDeviceMode.value = MOUSE_DEFAULTS.deviceMode
}
function setDefaultMouseDeviceGain() {
    mouseDeviceGain.value = MOUSE_DEFAULTS.deviceGain
}
function setDefaultMouseDeviceAccelEnabled() {
    mouseDeviceAccelEnabled.value = MOUSE_DEFAULTS.deviceAccelEnabled
}
function setDefaultMouseDeviceAccelBaseGain() {
    mouseDeviceAccelBaseGain.value = MOUSE_DEFAULTS.deviceAccelBaseGain
}
function setDefaultMouseDeviceAccelMaxGain() {
    mouseDeviceAccelMaxGain.value = MOUSE_DEFAULTS.deviceAccelMaxGain
}
function setDefaultMouseDeviceAccelVelForMax() {
    mouseDeviceAccelVelForMax.value = MOUSE_DEFAULTS.deviceAccelVelForMax
}
function setDefaultMouseDeviceGridMode() {
    mouseDeviceGridMode.value = MOUSE_DEFAULTS.deviceGridMode
}
function setDefaultMouseDeviceGridW() {
    mouseDeviceGridW.value = MOUSE_DEFAULTS.deviceGridW
}
function setDefaultMouseDeviceGridH() {
    mouseDeviceGridH.value = MOUSE_DEFAULTS.deviceGridH
}

function resetAllMouseToDefaults() {
    mouseSendRate.value = MOUSE_DEFAULTS.sendRate
    mouseSensitivity.value = MOUSE_DEFAULTS.sensitivity
    mouseSmoothing.value = MOUSE_DEFAULTS.smoothing
    mouseMaxDeltaPerSend.value = MOUSE_DEFAULTS.maxDeltaPerSend
    mouseInvertX.value = MOUSE_DEFAULTS.invertX
    mouseInvertY.value = MOUSE_DEFAULTS.invertY

    mouseDeviceAutoApply.value = MOUSE_DEFAULTS.deviceAutoApply
    mouseDeviceMode.value = MOUSE_DEFAULTS.deviceMode
    mouseDeviceGain.value = MOUSE_DEFAULTS.deviceGain

    mouseDeviceAccelEnabled.value = MOUSE_DEFAULTS.deviceAccelEnabled
    mouseDeviceAccelBaseGain.value = MOUSE_DEFAULTS.deviceAccelBaseGain
    mouseDeviceAccelMaxGain.value = MOUSE_DEFAULTS.deviceAccelMaxGain
    mouseDeviceAccelVelForMax.value = MOUSE_DEFAULTS.deviceAccelVelForMax

    mouseDeviceGridMode.value = MOUSE_DEFAULTS.deviceGridMode
    mouseDeviceGridW.value = MOUSE_DEFAULTS.deviceGridW
    mouseDeviceGridH.value = MOUSE_DEFAULTS.deviceGridH

    resetMouseFilterState()
}

function clampNum(n: number, min: number, max: number, fallback: number): number {
    if (!Number.isFinite(n)) return fallback
    return Math.max(min, Math.min(max, n))
}
function clampIntSigned(n: number, min: number, max: number, fallback: number = min): number {
    const fbRaw = Number.isFinite(fallback) ? Math.trunc(fallback) : min
    const fb = Math.max(min, Math.min(max, fbRaw))
    if (!Number.isFinite(n)) return fb
    const i = Math.trunc(n)
    return Math.max(min, Math.min(max, i))
}
function resetMouseFilterState() {
    floatCarryX = 0
    floatCarryY = 0
    smoothedX = 0
    smoothedY = 0
}

/* -------------------------------------------------------------------------- */
/*  Front panel buttons state (visibility + position + hover)                 */
/* -------------------------------------------------------------------------- */

const fpButtonsPosition = ref<FrontPanelButtonsPosition>('bottom-left')
const fpButtonsVisibility = ref<FrontPanelButtonsVisibility>('hover')

/* -------------------------------------------------------------------------- */
/*  Front panel LED indicators (visibility + position)                        */
/* -------------------------------------------------------------------------- */

const fpLedsPosition = ref<FrontPanelLedsPosition>('top-left-h')
const fpLedsVisibility = ref<FrontPanelLedsVisibility>('hover')

const isHoveringPane = ref(false)
function onPaneEnter() {
    isHoveringPane.value = true
}
function onPaneLeave() {
    isHoveringPane.value = false
}

const fpButtonsShouldShow = computed(() => {
    if (fpButtonsVisibility.value === 'hidden') return false
    if (fpButtonsVisibility.value === 'always') return true
    return isHoveringPane.value
})

const fpLedsShouldShow = computed(() => {
    if (fpLedsVisibility.value === 'hidden') return false
    if (fpLedsVisibility.value === 'always') return true
    return isHoveringPane.value
})

/* -------------------------------------------------------------------------- */
/*  Front panel readiness + LED state (from mirror)                           */
/* -------------------------------------------------------------------------- */

type FrontPanelPhase = 'disconnected' | 'connecting' | 'identifying' | 'ready' | 'error'
type FrontPanelPowerSense = 'on' | 'off' | 'unknown'

type FrontPanelSnapshot = {
    phase: FrontPanelPhase
    identified: boolean
    powerSense: FrontPanelPowerSense
    hddActive: boolean
}

function isFrontPanelPhase(x: any): x is FrontPanelPhase {
    return x === 'disconnected' || x === 'connecting' || x === 'identifying' || x === 'ready' || x === 'error'
}

function isPowerSense(x: any): x is FrontPanelPowerSense {
    return x === 'on' || x === 'off' || x === 'unknown'
}

const mirror = useMirror()
const fp = computed<FrontPanelSnapshot>(() => {
    const root = mirror.data as any
    const slice = root?.frontPanel as any

    const phase: FrontPanelPhase = isFrontPanelPhase(slice?.phase) ? slice.phase : 'disconnected'
    const powerSense: FrontPanelPowerSense = isPowerSense(slice?.powerSense) ? slice.powerSense : 'unknown'
    const identified = !!slice?.identified
    const hddActive = !!slice?.hddActive

    return { phase, identified, powerSense, hddActive }
})

const fpCanInteract = computed(() => fp.value.phase === 'ready' && fp.value.identified)

// Hard binding as requested:
const fpPowerLedMode = computed<FrontPanelLedMode>(() => (fp.value.powerSense === 'on' ? 'on' : 'off'))
const fpHddLedMode = computed<FrontPanelLedMode>(() => (fp.value.hddActive ? 'on' : 'off'))

const powerHeldByClient = ref(false)
const resetHeldByClient = ref(false)

/* -------------------------------------------------------------------------- */
/*  Viewer FPS cap (adaptive)                                                 */
/* -------------------------------------------------------------------------- */

const fpsMode = ref<StreamFpsMode>('auto')

// Auto-selected cap (only used when fpsMode === 'auto')
const autoMaxFps = ref<number>(30)

const resyncCount = ref(0)
const lastResyncTs = ref<number>(0)
const stableImproveTicks = ref<number>(0)

const MB = 1024 * 1024

function modeToFps(m: StreamFpsMode): number {
    if (m === 'auto') return autoMaxFps.value
    const n = parseInt(m, 10)
    return Number.isFinite(n) && n > 0 ? n : autoMaxFps.value
}

const effectiveMaxFps = computed(() => modeToFps(fpsMode.value))

const viewerCapLabel = computed(() => {
    if (fpsMode.value === 'auto') return `Auto (${effectiveMaxFps.value})`
    return `${effectiveMaxFps.value}`
})

const streamSrc = computed(() => {
    const params = new URLSearchParams()
    params.set('maxFps', String(effectiveMaxFps.value))
    return `${STREAM_ENDPOINT}?${params.toString()}`
})

function requestStreamResync(reason: string) {
    void reason
    if (!enabled.value) return
    const now = Date.now()
    if (now - lastResyncTs.value < 1500) return

    lastResyncTs.value = now
    resyncCount.value += 1
    reloadStream()
}

/* -------------------------------------------------------------------------- */
/*  WS access                                                                 */
/* -------------------------------------------------------------------------- */

const wsClientRef = ref<any | null>(null)
function refreshWsClient() {
    wsClientRef.value = getRealtimeClient()
}

let wsRetryTimer: number | null = null
let wsRetryStopTimer: number | null = null

onMounted(() => {
    refreshWsClient()

    wsRetryTimer = window.setInterval(() => {
        if (wsClientRef.value) {
            if (wsRetryTimer != null) window.clearInterval(wsRetryTimer)
            wsRetryTimer = null
            return
        }
        refreshWsClient()
    }, 250)

    wsRetryStopTimer = window.setTimeout(() => {
        if (wsRetryTimer != null) window.clearInterval(wsRetryTimer)
        wsRetryTimer = null
    }, 5000)
})

function trySend(obj: any): boolean {
    const ws = wsClientRef.value
    if (!ws) return false

    if (typeof ws.sendPs2KeyboardCommand === 'function') {
        ws.sendPs2KeyboardCommand(obj.payload)
        return true
    }

    if (typeof ws.send === 'function') {
        ws.send(obj)
        return true
    }

    return false
}

function sendKey(action: 'press' | 'hold' | 'release', code: string, key?: string) {
    trySend({
        type: 'ps2-keyboard.command',
        payload: { kind: 'key', action, code, key },
    })
}

/* -------------------------------------------------------------------------- */
/*  PS/2 mouse WS send + capture plumbing                                     */
/* -------------------------------------------------------------------------- */

type MouseButton = 'left' | 'right' | 'middle'

function sendMouse(payload: any) {
    refreshWsClient()
    const ws = wsClientRef.value
    if (!ws) return

    if (typeof ws.sendPs2MouseCommand === 'function') {
        ws.sendPs2MouseCommand(payload)
        return
    }

    if (typeof ws.send === 'function') {
        ws.send({
            type: 'ps2-mouse.command',
            payload,
        })
    }
}

function applyMouseDeviceConfig() {
    // Validate and send a single queued mouse.config op (device-side).
    const mode = mouseDeviceMode.value
    const gain = clampIntSigned(mouseDeviceGain.value, 1, 200)

    const accelEnabled = !!mouseDeviceAccelEnabled.value
    const baseGain = clampIntSigned(mouseDeviceAccelBaseGain.value, 1, 500)
    const maxGain = clampIntSigned(mouseDeviceAccelMaxGain.value, baseGain, 2000)
    const velForMax = clampIntSigned(mouseDeviceAccelVelForMax.value, 1, 500000)

    const gridMode = mouseDeviceGridMode.value
    const w = clampIntSigned(mouseDeviceGridW.value, 1, 100000)
    const h = clampIntSigned(mouseDeviceGridH.value, 1, 100000)

    const absoluteGrid =
        gridMode === 'fixed'
            ? { mode: 'fixed', fixed: { w, h } }
            : { mode: 'auto' }

    sendMouse({
        kind: 'mouse.config',
        mode,
        gain,
        accel: {
            enabled: accelEnabled,
            baseGain,
            maxGain,
            velocityPxPerSecForMax: velForMax,
        },
        absoluteGrid,
    })
}

function mapDomButton(btn: number): MouseButton | null {
    if (btn === 0) return 'left'
    if (btn === 1) return 'middle'
    if (btn === 2) return 'right'
    return null
}

const heldMouseButtons = new Set<MouseButton>()

// rate-limited sender state (supports RAF or fixed Hz)
let pendingDx = 0
let pendingDy = 0
let moveRaf: number | null = null
let moveTimer: number | null = null
let lastFlushAt = 0

// fractional + smoothing state
let floatCarryX = 0
let floatCarryY = 0
let smoothedX = 0
let smoothedY = 0

function clearMoveSchedule() {
    if (moveRaf != null) {
        cancelAnimationFrame(moveRaf)
        moveRaf = null
    }
    if (moveTimer != null) {
        window.clearTimeout(moveTimer)
        moveTimer = null
    }
}

function flushMouseMove() {
    clearMoveSchedule()

    if (!isPointerLockedToCaptureEl()) {
        pendingDx = 0
        pendingDy = 0
        return
    }

    const max = clampIntSigned(mouseMaxDeltaPerSend.value, 1, 10000)

    // Chunking: only send up to max per flush; keep remainder for subsequent flushes.
    let sendDx = pendingDx
    let sendDy = pendingDy

    if (Math.abs(sendDx) > max) sendDx = sendDx < 0 ? -max : max
    if (Math.abs(sendDy) > max) sendDy = sendDy < 0 ? -max : max

    pendingDx -= sendDx
    pendingDy -= sendDy

    if (sendDx !== 0 || sendDy !== 0) {
        sendMouse({
            kind: 'mouse.move.relative',
            dx: sendDx,
            dy: sendDy,
            requestedBy: 'stream-pane',
        })
        lastFlushAt = performance.now()
    }

    // If backlog remains (because of max delta/send), schedule another flush.
    if ((pendingDx !== 0 || pendingDy !== 0) && isPointerLockedToCaptureEl()) {
        scheduleMouseFlush()
    }
}

function scheduleMouseFlush() {
    if (!isPointerLockedToCaptureEl()) return

    if (mouseSendRate.value === 'raf') {
        if (moveRaf != null) return
        moveRaf = requestAnimationFrame(() => flushMouseMove())
        return
    }

    const hz = parseInt(mouseSendRate.value, 10)
    const effectiveHz = Number.isFinite(hz) && hz > 0 ? hz : 60
    const intervalMs = 1000 / effectiveHz

    if (moveTimer != null) return

    const now = performance.now()
    const elapsed = now - (lastFlushAt || 0)
    const delay = elapsed >= intervalMs ? 0 : intervalMs - elapsed

    moveTimer = window.setTimeout(() => flushMouseMove(), Math.max(0, Math.round(delay)))
}

function ingestMouseDelta(rawDx: number, rawDy: number) {
    // Apply client shaping: invert, sensitivity, smoothing, fractional carry.
    let dx = Number.isFinite(rawDx) ? rawDx : 0
    let dy = Number.isFinite(rawDy) ? rawDy : 0
    if (dx === 0 && dy === 0) return

    if (mouseInvertX.value) dx = -dx
    if (mouseInvertY.value) dy = -dy

    const sens = clampNum(mouseSensitivity.value, 0.05, 10, 1.0)
    let fx = dx * sens
    let fy = dy * sens

    const s = clampNum(mouseSmoothing.value, 0, 0.95, 0)
    if (s > 0) {
        // EMA smoothing
        smoothedX = smoothedX + s * (fx - smoothedX)
        smoothedY = smoothedY + s * (fy - smoothedY)
        fx = smoothedX
        fy = smoothedY
    } else {
        smoothedX = 0
        smoothedY = 0
    }

    floatCarryX += fx
    floatCarryY += fy

    const outDx = Math.trunc(floatCarryX)
    const outDy = Math.trunc(floatCarryY)

    floatCarryX -= outDx
    floatCarryY -= outDy

    if (outDx === 0 && outDy === 0) return

    pendingDx += outDx
    pendingDy += outDy
    scheduleMouseFlush()
}

function releaseAllMouseButtons() {
    if (heldMouseButtons.size === 0) return
    const buttons = Array.from(heldMouseButtons)
    heldMouseButtons.clear()
    for (const b of buttons) {
        sendMouse({ kind: 'mouse.button.up', button: b, requestedBy: 'stream-pane' })
    }
}

/* -------------------------------------------------------------------------- */
/*  Front panel WS send + controls                                            */
/* -------------------------------------------------------------------------- */

function sendFrontPanel(kind: string, payload: Record<string, unknown> = {}) {
    refreshWsClient()
    const ws = wsClientRef.value
    if (!ws) return

    const body = {
        kind,
        requestedBy: 'stream-pane',
        ...payload,
    }

    if (typeof ws.sendFrontPanelCommand === 'function') {
        ws.sendFrontPanelCommand(body)
        return
    }

    if (typeof ws.send === 'function') {
        ws.send({
            type: 'frontpanel.command',
            payload: body,
        })
    }
}

function onPowerHoldStart() {
    if (!fpCanInteract.value) return
    if (powerHeldByClient.value) return
    powerHeldByClient.value = true
    sendFrontPanel('powerHold')
}

function onPowerHoldEnd() {
    const wasHeld = powerHeldByClient.value
    powerHeldByClient.value = false
    if (!wasHeld) return
    sendFrontPanel('powerRelease')
}

function onResetHoldStart() {
    if (!fpCanInteract.value) return
    if (resetHeldByClient.value) return
    resetHeldByClient.value = true
    sendFrontPanel('resetHold')
}

function onResetHoldEnd() {
    const wasHeld = resetHeldByClient.value
    resetHeldByClient.value = false
    if (!wasHeld) return
    sendFrontPanel('resetRelease')
}

watch(
    () => fpCanInteract.value,
    (ok, prev) => {
        if (ok) return
        if (prev) {
            if (powerHeldByClient.value) {
                powerHeldByClient.value = false
                sendFrontPanel('powerRelease')
            }
            if (resetHeldByClient.value) {
                resetHeldByClient.value = false
                sendFrontPanel('resetRelease')
            }
        } else {
            powerHeldByClient.value = false
            resetHeldByClient.value = false
        }
    },
    { immediate: true }
)

/* -------------------------------------------------------------------------- */
/*  Keyboard capture (pointer lock is the ONLY capture mode)                  */
/* -------------------------------------------------------------------------- */

const captureRef = ref<HTMLElement | null>(null)
const isCapturing = ref(false)
const armOnNextFocus = ref(false)

const MODIFIER_CODES = new Set<string>([
    'ShiftLeft',
    'ShiftRight',
    'ControlLeft',
    'ControlRight',
    'AltLeft',
    'AltRight',
    'MetaLeft',
    'MetaRight',
])

const heldModifiers = new Set<string>()
const canCapture = computed(() => enabled.value)

function isPointerLockedToCaptureEl(): boolean {
    const el = captureRef.value
    if (!el) return false
    return document.pointerLockElement === el
}

function requestPointerLock() {
    const el = captureRef.value
    if (!el) return
    if (!canCapture.value) return
    if (document.pointerLockElement === el) return

    try {
        ;(el as any).requestPointerLock?.()
    } catch {
        // ignore
    }
}

function exitPointerLock() {
    if (!isPointerLockedToCaptureEl()) return
    try {
        document.exitPointerLock?.()
    } catch {
        // ignore
    }
}

function focusCaptureLayer(): boolean {
    const el = captureRef.value
    if (!el) return false
    try {
        ;(el as any).focus?.({ preventScroll: true })
    } catch {
        try {
            el.focus?.()
        } catch {
            // ignore
        }
    }
    return document.activeElement === el
}

function onCaptureMouseDown(e: MouseEvent) {
    if (!canCapture.value) return

    refreshWsClient()

    const focused = focusCaptureLayer()
    armOnNextFocus.value = !focused

    if (!isPointerLockedToCaptureEl()) {
        requestPointerLock()
        return
    }

    const b = mapDomButton(e.button)
    if (!b) return
    heldMouseButtons.add(b)
    sendMouse({ kind: 'mouse.button.down', button: b, requestedBy: 'stream-pane' })
}

function onCaptureMouseUp(e: MouseEvent) {
    if (!isCapturing.value) return
    if (!isPointerLockedToCaptureEl()) return
    const b = mapDomButton(e.button)
    if (!b) return
    heldMouseButtons.delete(b)
    sendMouse({ kind: 'mouse.button.up', button: b, requestedBy: 'stream-pane' })
}

function onCaptureMouseMove(e: MouseEvent) {
    if (!isCapturing.value) return
    if (!isPointerLockedToCaptureEl()) return

    const dx = Number.isFinite(e.movementX) ? Math.trunc(e.movementX) : 0
    const dy = Number.isFinite(e.movementY) ? Math.trunc(e.movementY) : 0
    if (dx === 0 && dy === 0) return

    ingestMouseDelta(dx, dy)
}

function onCaptureWheel(e: WheelEvent) {
    if (!isCapturing.value) return
    if (!isPointerLockedToCaptureEl()) return

    const dy = e.deltaY === 0 ? 0 : e.deltaY > 0 ? 1 : -1
    if (!dy) return

    sendMouse({ kind: 'mouse.wheel', dy, requestedBy: 'stream-pane' })
}

function releaseCapture(opts?: { fromBlur?: boolean }) {
    const fromBlur = !!opts?.fromBlur

    sendMouse({ kind: 'mouse.cancelAll', reason: 'capture_end', requestedBy: 'stream-pane' })

    releaseAllMouseButtons()

    pendingDx = 0
    pendingDy = 0
    clearMoveSchedule()
    resetMouseFilterState()

    if (heldModifiers.size > 0) {
        const codes = Array.from(heldModifiers).sort()
        for (const code of codes) sendKey('release', code)
    }
    heldModifiers.clear()

    isCapturing.value = false
    armOnNextFocus.value = false

    if (!fromBlur) {
        try {
            captureRef.value?.blur?.()
        } catch {
            // ignore
        }
    }
}

function onPointerLockChange() {
    const locked = isPointerLockedToCaptureEl()

    if (locked) {
        isCapturing.value = true
        armOnNextFocus.value = false
        refreshWsClient()
        focusCaptureLayer()

        if (mouseDeviceAutoApply.value) {
            applyMouseDeviceConfig()
        }

        return
    }

    if (isCapturing.value || heldModifiers.size > 0 || armOnNextFocus.value || heldMouseButtons.size > 0) {
        releaseCapture({ fromBlur: true })
    } else {
        armOnNextFocus.value = false
    }
}

function onPointerLockError() {
    if (isCapturing.value || heldModifiers.size > 0 || armOnNextFocus.value || heldMouseButtons.size > 0) {
        releaseCapture({ fromBlur: true })
    }
}

function onWindowBlur() {
    if (!isPointerLockedToCaptureEl()) return
    try {
        document.exitPointerLock?.()
    } catch {
        // ignore
    }
}

function onVisibilityChange() {
    if (document.visibilityState !== 'visible') onWindowBlur()
}

onMounted(() => {
    document.addEventListener('pointerlockchange', onPointerLockChange)
    document.addEventListener('pointerlockerror', onPointerLockError)
    window.addEventListener('blur', onWindowBlur)
    document.addEventListener('visibilitychange', onVisibilityChange)
})

function onFocusCapture() {
    if (!canCapture.value) {
        if (isPointerLockedToCaptureEl()) exitPointerLock()
        releaseCapture({ fromBlur: true })
        return
    }

    refreshWsClient()
    armOnNextFocus.value = false
}

function onBlurCapture() {
    if (isPointerLockedToCaptureEl()) {
        exitPointerLock()
        return
    }

    if (!isCapturing.value && !armOnNextFocus.value && heldModifiers.size === 0 && heldMouseButtons.size === 0) return
    releaseCapture({ fromBlur: true })
}

function blockBrowser(e: KeyboardEvent) {
    e.preventDefault()
    e.stopPropagation()
}

function onKeyDown(e: KeyboardEvent) {
    if (!isCapturing.value) return

    const code = e.code || ''
    if (!code) {
        blockBrowser(e)
        return
    }

    if (code === 'Escape') return

    if (MODIFIER_CODES.has(code)) {
        if (!e.repeat && !heldModifiers.has(code)) {
            sendKey('hold', code, e.key)
            heldModifiers.add(code)
        }
        blockBrowser(e)
        return
    }

    sendKey('press', code, e.key)
    blockBrowser(e)
}

function onKeyUp(e: KeyboardEvent) {
    if (!isCapturing.value) return

    const code = e.code || ''
    if (!code) {
        blockBrowser(e)
        return
    }

    if (MODIFIER_CODES.has(code) && heldModifiers.has(code)) {
        sendKey('release', code, e.key)
        heldModifiers.delete(code)
    }

    blockBrowser(e)
}

watch(
    () => enabled.value,
    (v) => {
        if (v) return
        if (isPointerLockedToCaptureEl()) {
            exitPointerLock()
            return
        }
        if (isCapturing.value || armOnNextFocus.value || heldModifiers.size > 0 || heldMouseButtons.size > 0) {
            releaseCapture({ fromBlur: true })
        }
    }
)

/* -------------------------------------------------------------------------- */
/*  Stream sizing                                                             */
/* -------------------------------------------------------------------------- */

type StreamMeta = { w: number; h: number; ar: number }
const streamMeta = ref<StreamMeta | null>(null)
const frameBox = ref<{ w: number; h: number } | null>(null)

function clampInt(n: number, min: number, max: number): number {
    if (!Number.isFinite(n)) return min
    return Math.max(min, Math.min(max, Math.round(n)))
}

function updateFrameBox() {
    const el = captureRef.value
    if (!el) return

    const r = el.getBoundingClientRect()
    const cw = Math.max(0, Math.floor(r.width))
    const ch = Math.max(0, Math.floor(r.height))
    if (cw <= 0 || ch <= 0) return

    const meta = streamMeta.value
    const ar = meta?.ar && Number.isFinite(meta.ar) && meta.ar > 0 ? meta.ar : 4 / 3

    if (scaleMode.value === 'fit') {
        const containerAr = cw / ch
        let w = cw
        let h = ch

        if (containerAr > ar) {
            h = ch
            w = Math.floor(h * ar)
        } else {
            w = cw
            h = Math.floor(w / ar)
        }

        frameBox.value = {
            w: clampInt(w, 1, cw),
            h: clampInt(h, 1, ch),
        }
        return
    }

    if (scaleMode.value === 'native') {
        if (meta?.w && meta?.h) {
            frameBox.value = { w: Math.max(1, Math.floor(meta.w)), h: Math.max(1, Math.floor(meta.h)) }
        } else {
            frameBox.value = null
        }
        return
    }

    frameBox.value = null
}

function onStreamLoad(e: Event) {
    const img = e.target as HTMLImageElement | null
    if (!img) return
    const w = img.naturalWidth
    const h = img.naturalHeight
    if (w && h) streamMeta.value = { w, h, ar: w / h }
    updateFrameBox()
}

const streamFrameStyle = computed(() => {
    const mode = scaleMode.value
    if (mode === 'fit' || mode === 'native') {
        const b = frameBox.value
        if (b) return { width: `${b.w}px`, height: `${b.h}px` }
        return { width: '100%', height: '100%' }
    }
    return { width: '100%', height: '100%' }
})

let frameResizeObs: ResizeObserver | null = null

onMounted(() => {
    const el = captureRef.value
    if (el && typeof ResizeObserver !== 'undefined') {
        frameResizeObs = new ResizeObserver(() => updateFrameBox())
        frameResizeObs.observe(el)
    }
    updateFrameBox()
})

watch(
    () => scaleMode.value,
    () => updateFrameBox()
)

/* -------------------------------------------------------------------------- */
/*  Per-pane persistence                                                      */
/* -------------------------------------------------------------------------- */

function isValidScaleMode(x: any): x is 'fit' | 'fill' | 'stretch' | 'native' {
    return x === 'fit' || x === 'fill' || x === 'stretch' || x === 'native'
}
function isValidBgMode(x: any): x is 'black' | 'pane' {
    return x === 'black' || x === 'pane'
}
function isValidFpsMode(x: any): x is StreamFpsMode {
    return (
        x === 'auto' ||
        x === '60' ||
        x === '30' ||
        x === '20' ||
        x === '15' ||
        x === '8' ||
        x === '4' ||
        x === '2'
    )
}
function isValidFpPos(x: any): x is FrontPanelButtonsPosition {
    return x === 'bottom-left' || x === 'bottom-right'
}
function isValidFpVis(x: any): x is FrontPanelButtonsVisibility {
    return x === 'always' || x === 'hover' || x === 'hidden'
}

function isValidFpLedsPos(x: any): x is FrontPanelLedsPosition {
    return (
        x === 'top-left-h' ||
        x === 'top-left-v' ||
        x === 'top-right-h' ||
        x === 'top-right-v' ||
        x === 'bottom-right-h' ||
        x === 'bottom-right-v'
    )
}

function isValidFpLedsVis(x: any): x is FrontPanelLedsVisibility {
    return x === 'always' || x === 'hover' || x === 'hidden'
}

function isValidMouseSendRate(x: any): x is MouseSendRateMode {
    return x === 'raf' || x === '120' || x === '90' || x === '60' || x === '30' || x === '20' || x === '15'
}
function isValidMouseDeviceMode(x: any): x is MouseDeviceMode {
    return x === 'relative-gain' || x === 'relative-accel' || x === 'absolute'
}
function isValidMouseGridMode(x: any): x is MouseGridMode {
    return x === 'auto' || x === 'fixed'
}

const paneId = computed(() => String(props.pane?.id ?? '').trim())
const STORAGE_PREFIX = 'stream:pane:ui:'
const storageKey = computed(() => (paneId.value ? `${STORAGE_PREFIX}${paneId.value}` : ''))

// Increment when changing defaults/migrations.
const STREAM_PANE_PREFS_REV = 2

function readPanePrefs(): StreamPanePrefs | null {
    const key = storageKey.value
    if (!key) return null
    try {
        const raw = localStorage.getItem(key)
        if (!raw) return null
        const parsed = JSON.parse(raw)
        return parsed && typeof parsed === 'object' ? (parsed as StreamPanePrefs) : null
    } catch {
        return null
    }
}

function writePanePrefs(p: StreamPanePrefs) {
    const key = storageKey.value
    if (!key) return
    try {
        const raw = JSON.stringify(p)
        localStorage.setItem(key, raw)
    } catch {
        // ignore
    }
}

function getPrefsRev(prefs: StreamPanePrefs | null | undefined): number {
    const raw = (prefs as any)?.prefsRev
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0
    return Math.max(0, Math.floor(raw))
}

function migratePanePrefs(prefs: StreamPanePrefs): StreamPanePrefs {
    const rev = getPrefsRev(prefs)
    if (rev >= STREAM_PANE_PREFS_REV) return prefs

    const out: StreamPanePrefs = { ...prefs, prefsRev: STREAM_PANE_PREFS_REV }

    // Legacy defaults from older builds (before mouse batching fixes):
    //   mouseSendRate: '60'
    //   mouseMaxDeltaPerSend: 80
    //   mouseDeviceAutoApply: false
    //   mouseDeviceGain: 10
    //   mouseDeviceAccelEnabled: true
    //   mouseDeviceAccelBaseGain: 5
    //   mouseDeviceAccelMaxGain: 20
    //   mouseDeviceAccelVelForMax: 1000
    //
    // These can cause micro-movements to batch into multi-count deltas, which then
    // get amplified by device gain/accel (perceived as “snapping to a grid”).
    const msr = (prefs as any).mouseSendRate
    const mdps = (prefs as any).mouseMaxDeltaPerSend

    const auto = (prefs as any).mouseDeviceAutoApply
    const gain = (prefs as any).mouseDeviceGain
    const accelEnabled = (prefs as any).mouseDeviceAccelEnabled
    const base = (prefs as any).mouseDeviceAccelBaseGain
    const max = (prefs as any).mouseDeviceAccelMaxGain
    const vel = (prefs as any).mouseDeviceAccelVelForMax

    const looksLikeLegacyDeviceDefaults =
        (typeof auto !== 'boolean' || auto === false) &&
        (typeof gain !== 'number' || gain === 10) &&
        (typeof accelEnabled !== 'boolean' || accelEnabled === true) &&
        (typeof base !== 'number' || base === 5) &&
        (typeof max !== 'number' || max === 20) &&
        (typeof vel !== 'number' || vel === 1000)

    if (looksLikeLegacyDeviceDefaults) {
        out.mouseDeviceAutoApply = MOUSE_DEFAULTS.deviceAutoApply
        out.mouseDeviceGain = MOUSE_DEFAULTS.deviceGain
        out.mouseDeviceAccelEnabled = MOUSE_DEFAULTS.deviceAccelEnabled
        out.mouseDeviceAccelBaseGain = MOUSE_DEFAULTS.deviceAccelBaseGain
        out.mouseDeviceAccelMaxGain = MOUSE_DEFAULTS.deviceAccelMaxGain
        // keep velocityPxPerSecForMax as-is
    }

    const looksLikeLegacyClientDefaults =
        (typeof mdps !== 'number' || mdps === 80) &&
        (typeof msr !== 'string' || msr === '60')

    if (looksLikeLegacyClientDefaults) {
        out.mouseSendRate = MOUSE_DEFAULTS.sendRate
        out.mouseMaxDeltaPerSend = MOUSE_DEFAULTS.maxDeltaPerSend
    } else {
        if (typeof mdps !== 'number' || mdps === 80) out.mouseMaxDeltaPerSend = MOUSE_DEFAULTS.maxDeltaPerSend
        if (typeof msr !== 'string') out.mouseSendRate = MOUSE_DEFAULTS.sendRate
    }

    return out
}

function applyPanePrefs(prefs?: StreamPanePrefs | null) {
    if (!prefs || typeof prefs !== 'object') return

    const nextEnabled = (prefs as any).enabled
    if (typeof nextEnabled === 'boolean') enabled.value = nextEnabled

    const nextScale = (prefs as any).scaleMode
    if (isValidScaleMode(nextScale)) scaleMode.value = nextScale

    const nextBg = (prefs as any).bgMode
    if (isValidBgMode(nextBg)) bgMode.value = nextBg

    const nextFps = (prefs as any).fpsMode
    if (isValidFpsMode(nextFps)) fpsMode.value = nextFps

    const nextFpPos = (prefs as any).fpButtonsPosition
    if (isValidFpPos(nextFpPos)) fpButtonsPosition.value = nextFpPos

    const nextFpVis = (prefs as any).fpButtonsVisibility
    if (isValidFpVis(nextFpVis)) fpButtonsVisibility.value = nextFpVis

    const nextLedsPos = (prefs as any).fpLedsPosition
    // normalize legacy values so the <select> always has a matching option
    if (nextLedsPos === 'top-left') fpLedsPosition.value = 'top-left-h'
    else if (nextLedsPos === 'top-right') fpLedsPosition.value = 'top-right-h'
    else if (isValidFpLedsPos(nextLedsPos)) fpLedsPosition.value = nextLedsPos


    const nextLedsVis = (prefs as any).fpLedsVisibility
    if (isValidFpLedsVis(nextLedsVis)) fpLedsVisibility.value = nextLedsVis

    // Mouse client prefs
    const msr = (prefs as any).mouseSendRate
    if (isValidMouseSendRate(msr)) mouseSendRate.value = msr

    const sens = (prefs as any).mouseSensitivity
    if (typeof sens === 'number' && Number.isFinite(sens)) mouseSensitivity.value = clampNum(sens, 0.05, 10, 1)

    const sm = (prefs as any).mouseSmoothing
    if (typeof sm === 'number' && Number.isFinite(sm)) mouseSmoothing.value = clampNum(sm, 0, 0.95, 0)

    const md = (prefs as any).mouseMaxDeltaPerSend
    if (typeof md === 'number' && Number.isFinite(md)) mouseMaxDeltaPerSend.value = clampIntSigned(md, 1, 10000)

    const invX = (prefs as any).mouseInvertX
    if (typeof invX === 'boolean') mouseInvertX.value = invX

    const invY = (prefs as any).mouseInvertY
    if (typeof invY === 'boolean') mouseInvertY.value = invY

    // Mouse device prefs
    const auto = (prefs as any).mouseDeviceAutoApply
    if (typeof auto === 'boolean') mouseDeviceAutoApply.value = auto

    const m = (prefs as any).mouseDeviceMode
    if (isValidMouseDeviceMode(m)) mouseDeviceMode.value = m

    const g = (prefs as any).mouseDeviceGain
    if (typeof g === 'number' && Number.isFinite(g)) mouseDeviceGain.value = clampIntSigned(g, 1, 200)

    const ae = (prefs as any).mouseDeviceAccelEnabled
    if (typeof ae === 'boolean') mouseDeviceAccelEnabled.value = ae

    const ab = (prefs as any).mouseDeviceAccelBaseGain
    if (typeof ab === 'number' && Number.isFinite(ab)) mouseDeviceAccelBaseGain.value = clampIntSigned(ab, 1, 500)

    const am = (prefs as any).mouseDeviceAccelMaxGain
    if (typeof am === 'number' && Number.isFinite(am)) mouseDeviceAccelMaxGain.value = clampIntSigned(am, 1, 2000)

    const av = (prefs as any).mouseDeviceAccelVelForMax
    if (typeof av === 'number' && Number.isFinite(av)) mouseDeviceAccelVelForMax.value = clampIntSigned(av, 1, 500000)

    const gm = (prefs as any).mouseDeviceGridMode
    if (isValidMouseGridMode(gm)) mouseDeviceGridMode.value = gm

    const gw = (prefs as any).mouseDeviceGridW
    if (typeof gw === 'number' && Number.isFinite(gw)) mouseDeviceGridW.value = clampIntSigned(gw, 1, 100000)

    const gh = (prefs as any).mouseDeviceGridH
    if (typeof gh === 'number' && Number.isFinite(gh)) mouseDeviceGridH.value = clampIntSigned(gh, 1, 100000)

    const mpo = (prefs as any).mousePanelOpen
    if (typeof mpo === 'boolean') mousePanelOpen.value = mpo

    const hpo = (prefs as any).healthPanelOpen
    if (typeof hpo === 'boolean') healthPanelOpen.value = hpo
}

function exportPanePrefs(): StreamPanePrefs {
    return {
        prefsRev: STREAM_PANE_PREFS_REV,

        enabled: !!enabled.value,
        scaleMode: scaleMode.value,
        bgMode: bgMode.value,
        fpsMode: fpsMode.value,
        fpButtonsPosition: fpButtonsPosition.value,
        fpButtonsVisibility: fpButtonsVisibility.value,
        fpLedsPosition: fpLedsPosition.value,
        fpLedsVisibility: fpLedsVisibility.value,

        mouseSendRate: mouseSendRate.value,
        mouseSensitivity: mouseSensitivity.value,
        mouseSmoothing: mouseSmoothing.value,
        mouseMaxDeltaPerSend: mouseMaxDeltaPerSend.value,
        mouseInvertX: mouseInvertX.value,
        mouseInvertY: mouseInvertY.value,

        mouseDeviceAutoApply: mouseDeviceAutoApply.value,
        mouseDeviceMode: mouseDeviceMode.value,
        mouseDeviceGain: mouseDeviceGain.value,
        mouseDeviceAccelEnabled: mouseDeviceAccelEnabled.value,
        mouseDeviceAccelBaseGain: mouseDeviceAccelBaseGain.value,
        mouseDeviceAccelMaxGain: mouseDeviceAccelMaxGain.value,
        mouseDeviceAccelVelForMax: mouseDeviceAccelVelForMax.value,
        mouseDeviceGridMode: mouseDeviceGridMode.value,
        mouseDeviceGridW: mouseDeviceGridW.value,
        mouseDeviceGridH: mouseDeviceGridH.value,

        mousePanelOpen: mousePanelOpen.value,
        healthPanelOpen: healthPanelOpen.value,
    }
}

const lastHydratedSig = ref<string>('')

function hydrateForPane() {
    const key = storageKey.value
    const rev = typeof props.__streamPaneProfileRev === 'number' ? props.__streamPaneProfileRev : 0
    const hasEmbed = isObject(props.__streamPaneUi)

    if (!key) {
        const sig = `nokey|rev:${rev}|embed:${hasEmbed ? 1 : 0}`
        if (lastHydratedSig.value === sig) return
        lastHydratedSig.value = sig
        if (hasEmbed) applyPanePrefs(props.__streamPaneUi as StreamPanePrefs)
        return
    }

    const sig = `${key}|rev:${rev}|embed:${hasEmbed ? 1 : 0}`
    if (lastHydratedSig.value === sig) return
    lastHydratedSig.value = sig

    if (hasEmbed) {
        applyPanePrefs(props.__streamPaneUi as StreamPanePrefs)
        writePanePrefs(exportPanePrefs())
        return
    }

    const stored = readPanePrefs()
    if (stored) {
        const migrated = migratePanePrefs(stored)
        applyPanePrefs(migrated)
        if (migrated !== stored) writePanePrefs(migrated)
    }
}

onMounted(() => hydrateForPane())
watch([paneId, () => props.__streamPaneUi, () => props.__streamPaneProfileRev], () => hydrateForPane())
watch(
    [
        () => enabled.value,
        () => scaleMode.value,
        () => bgMode.value,
        () => fpsMode.value,
        () => fpButtonsPosition.value,
        () => fpButtonsVisibility.value,
        () => fpLedsPosition.value,
        () => fpLedsVisibility.value,

        () => mouseSendRate.value,
        () => mouseSensitivity.value,
        () => mouseSmoothing.value,
        () => mouseMaxDeltaPerSend.value,
        () => mouseInvertX.value,
        () => mouseInvertY.value,

        () => mouseDeviceAutoApply.value,
        () => mouseDeviceMode.value,
        () => mouseDeviceGain.value,
        () => mouseDeviceAccelEnabled.value,
        () => mouseDeviceAccelBaseGain.value,
        () => mouseDeviceAccelMaxGain.value,
        () => mouseDeviceAccelVelForMax.value,
        () => mouseDeviceGridMode.value,
        () => mouseDeviceGridW.value,
        () => mouseDeviceGridH.value,

        () => mousePanelOpen.value,
        () => healthPanelOpen.value,
    ],
    () => writePanePrefs(exportPanePrefs())
)

watch(
    [() => mouseSensitivity.value, () => mouseSmoothing.value, () => mouseInvertX.value, () => mouseInvertY.value],
    () => resetMouseFilterState()
)

/* -------------------------------------------------------------------------- */
/*  Health state + formatting                                                 */
/* -------------------------------------------------------------------------- */

const health = ref<SidecarHealth | null>(null)
const healthLoading = ref(false)
const healthError = ref<string | null>(null)

const healthRttMs = ref<number | null>(null)
let healthInFlight = false
let healthPollTimer: number | null = null

function clampNonNeg(n: number): number {
    if (!Number.isFinite(n)) return 0
    return Math.max(0, Math.floor(n))
}

function formatAge(ms: number): string {
    const v = clampNonNeg(ms)
    if (v < 1000) return `${v}ms`
    const s = v / 1000
    if (s < 60) return `${s.toFixed(1)}s`
    const m = Math.floor(s / 60)
    const rs = Math.floor(s % 60)
    return `${m}m${String(rs).padStart(2, '0')}s`
}

function formatBytes(n: number): string {
    const v = Math.max(0, Math.floor(n))
    if (v < 1024) return `${v}B`
    const kb = v / 1024
    if (kb < 1024) return `${kb.toFixed(0)}KB`
    const mb = kb / 1024
    return `${mb.toFixed(1)}MB`
}

function formatBps(bps: number): string {
    const v = Math.max(0, Math.floor(bps))
    if (v < 1024) return `${v}B/s`
    const kb = v / 1024
    if (kb < 1024) return `${kb.toFixed(0)}KB/s`
    const mb = kb / 1024
    return `${mb.toFixed(1)}MB/s`
}

const formattedUptime = computed(() => {
    const sec = health.value?.uptimeSec
    if (sec == null || !Number.isFinite(sec) || sec < 0) return '—'
    const total = Math.floor(sec)
    const hours = Math.floor(total / 3600)
    const minutes = Math.floor((total % 3600) / 60)
    const seconds = total % 60
    const parts: string[] = []
    if (hours > 0) parts.push(`${hours}h`)
    if (minutes > 0 || hours > 0) parts.push(`${minutes}m`)
    parts.push(`${seconds}s`)
    return parts.join(' ')
})

const captureAgeMs = computed(() => {
    const ms = health.value?.capture?.lastFrameAgeMs
    if (ms == null || !Number.isFinite(ms)) return null
    return clampNonNeg(ms)
})
const formattedCaptureAge = computed(() => (captureAgeMs.value == null ? '—' : formatAge(captureAgeMs.value)))
const captureAgeBucket = computed(() => {
    const ms = captureAgeMs.value
    if (ms == null) return 'unknown'
    if (ms <= 250) return 'ok'
    if (ms <= 1000) return 'warn'
    return 'bad'
})

const streamDiag = computed(() => health.value?.capture?.streamDiag ?? null)

const backlogMs = computed(() => {
    const ms = streamDiag.value?.estBacklogMs
    if (ms == null || !Number.isFinite(ms)) return null
    return clampNonNeg(ms)
})
const formattedBacklog = computed(() => (backlogMs.value == null ? '—' : formatAge(backlogMs.value)))
const backlogBucket = computed(() => {
    const ms = backlogMs.value
    if (ms == null) return 'unknown'
    if (ms <= 250) return 'ok'
    if (ms <= 1000) return 'warn'
    return 'bad'
})

const formattedBuffered = computed(() => {
    const d = streamDiag.value
    if (!d) return '—'
    const ratio = Number.isFinite(d.maxClientBufferedRatio) ? d.maxClientBufferedRatio : 0
    return `${formatBytes(d.maxClientBufferedBytes)} · x${ratio.toFixed(2)}`
})

const formattedDownstream = computed(() => {
    const d = streamDiag.value
    if (!d || d.downstreamBps == null) return '—'
    return formatBps(d.downstreamBps)
})

const formattedBackpressure = computed(() => {
    const d = streamDiag.value
    if (!d) return '—'
    return `${d.backpressureEvents}`
})

const formattedAvgFrame = computed(() => {
    const d = streamDiag.value
    if (!d) return '—'
    const avg = d.avgFrameBytes
    if (avg == null) return `${formatBytes(d.lastFrameBytes)}`
    return `${formatBytes(avg)}`
})

async function loadHealth(opts?: { silent?: boolean }) {
    if (healthInFlight) return
    healthInFlight = true

    const silent = !!opts?.silent
    if (!silent) healthLoading.value = true
    healthError.value = null

    const t0 = performance.now()

    try {
        const res = await fetch(HEALTH_ENDPOINT, {
            method: 'GET',
            headers: { Accept: 'application/json' },
        })

        const t1 = performance.now()
        healthRttMs.value = Math.max(0, Math.round(t1 - t0))

        let json: unknown = null
        try {
            json = await res.json()
        } catch {
            json = null
        }

        if (json && typeof json === 'object') {
            health.value = json as SidecarHealth
        } else if (res.ok) {
            health.value = null
        }

        if (!res.ok) {
            healthError.value = `Sidecar unhealthy (HTTP ${res.status})`
            return
        }

        healthError.value = null
        return
    } catch (err: any) {
        healthError.value = err?.message ? `Failed to load health: ${err.message}` : 'Failed to load health'
        return
    } finally {
        healthInFlight = false
        if (!silent) healthLoading.value = false
    }
}

/* -------------------------------------------------------------------------- */
/*  Auto throttle logic                                                       */
/* -------------------------------------------------------------------------- */

function nextHigherFps(cur: number): number {
    const levels = [2, 4, 8, 15, 20, 30, 60] as const
    for (const lvl of levels) {
        if (cur <= lvl) return lvl
    }
    return levels[levels.length - 1]!
}

function suggestFpsFromDiag(d: SidecarStreamDiag | null): number {
    if (!d) return autoMaxFps.value

    const backlog = Number.isFinite(d.estBacklogMs as any) ? (d.estBacklogMs as number) : 0
    const buffered = Number.isFinite(d.maxClientBufferedBytes as any) ? d.maxClientBufferedBytes : 0
    const ratio = Number.isFinite(d.maxClientBufferedRatio as any) ? d.maxClientBufferedRatio : 0

    if (backlog >= 5000 || buffered >= 64 * MB || ratio >= 64) return 2
    if (backlog >= 3000 || buffered >= 32 * MB || ratio >= 32) return 4
    if (backlog >= 2000 || buffered >= 24 * MB || ratio >= 24) return 8

    if (backlog >= 900 || buffered >= 12 * MB || ratio >= 12) return 15
    if (backlog >= 450 || buffered >= 6 * MB || ratio >= 6) return 20

    if (backlog >= 200 || buffered >= 2 * MB || ratio >= 3) return 30
    return 60
}

function maybeAutoAdjust() {
    if (!enabled.value) return
    if (fpsMode.value !== 'auto') return

    const d = streamDiag.value
    if (!d) return

    const suggested = suggestFpsFromDiag(d)
    const current = autoMaxFps.value

    const backlog = typeof d.estBacklogMs === 'number' ? d.estBacklogMs : 0
    const buffered = typeof d.maxClientBufferedBytes === 'number' ? d.maxClientBufferedBytes : 0
    if (backlog >= 1000 || buffered >= 8 * MB) {
        requestStreamResync('backlog_high')
    }

    if (suggested < current) {
        stableImproveTicks.value = 0
        autoMaxFps.value = suggested
        requestStreamResync('cap_downshift')
        return
    }

    if (suggested > current) {
        stableImproveTicks.value += 1
        if (stableImproveTicks.value >= 5) {
            stableImproveTicks.value = 0
            autoMaxFps.value = nextHigherFps(current)
            requestStreamResync('cap_upshift')
        }
        return
    }

    stableImproveTicks.value = 0
}

watch(
    () => health.value,
    () => {
        maybeAutoAdjust()
    }
)

watch(
    () => fpsMode.value,
    () => {
        if (!enabled.value) return
        requestStreamResync('fps_mode_changed')
    }
)

watch(
    () => effectiveMaxFps.value,
    (next, prev) => {
        if (!enabled.value) return
        if (next === prev) return
        if (fpsMode.value === 'auto') return
        requestStreamResync('max_fps_changed')
    }
)

/* -------------------------------------------------------------------------- */
/*  Polling control                                                           */
/* -------------------------------------------------------------------------- */

function setHealthPollingActive(active: boolean) {
    if (active) {
        if (healthPollTimer != null) return
        void loadHealth({ silent: !showControls.value })
        healthPollTimer = window.setInterval(() => void loadHealth({ silent: true }), 1000)
        return
    }

    if (healthPollTimer != null) window.clearInterval(healthPollTimer)
    healthPollTimer = null
}

function toggleControls() {
    showControls.value = !showControls.value
}

watch(
    () => showControls.value,
    (open) => {
        if (open) void loadHealth({ silent: false })
    }
)

watch(
    [() => enabled.value, () => showControls.value],
    ([en, open]) => {
        setHealthPollingActive(!!en || !!open)
    },
    { immediate: true }
)

function onEnabledChange() {
    if (enabled.value) {
        reloadStream()
    } else {
        if (isPointerLockedToCaptureEl()) {
            exitPointerLock()
        } else if (isCapturing.value || armOnNextFocus.value || heldModifiers.size > 0 || heldMouseButtons.size > 0) {
            releaseCapture({ fromBlur: true })
        }
    }
}

function reloadStream() {
    reloadKey.value++
}

onBeforeUnmount(() => {
    clearMoveSchedule()

    if (isPointerLockedToCaptureEl()) exitPointerLock()
    if (isCapturing.value || armOnNextFocus.value || heldModifiers.size > 0 || heldMouseButtons.size > 0) {
        releaseCapture({ fromBlur: true })
    }

    // best-effort: release front panel holds if pane unmounts mid-hold
    if (powerHeldByClient.value) {
        powerHeldByClient.value = false
        sendFrontPanel('powerRelease')
    }
    if (resetHeldByClient.value) {
        resetHeldByClient.value = false
        sendFrontPanel('resetRelease')
    }

    document.removeEventListener('pointerlockchange', onPointerLockChange)
    document.removeEventListener('pointerlockerror', onPointerLockError)
    window.removeEventListener('blur', onWindowBlur)
    document.removeEventListener('visibilitychange', onVisibilityChange)

    if (wsRetryTimer != null) window.clearInterval(wsRetryTimer)
    if (wsRetryStopTimer != null) window.clearTimeout(wsRetryStopTimer)
    wsRetryTimer = null
    wsRetryStopTimer = null

    if (frameResizeObs) frameResizeObs.disconnect()
    frameResizeObs = null

    if (healthPollTimer != null) window.clearInterval(healthPollTimer)
    healthPollTimer = null
})
</script>

<style scoped>
/* (styles mostly unchanged; mouse panel expanded for per-setting descriptions) */
.stream-pane {
    --pane-fg: #111;
    --panel-fg: #e6e6e6;

    --kb-accent: #ef4444;
    --kb-accent-rgb: 239, 68, 68;

    position: relative;
    display: flex;
    flex-direction: column;
    gap: 8px;
    height: 100%;
    width: 100%;
}

.stream-advanced-hotspot {
    position: absolute;
    top: 0;
    right: 0;
    width: 3.2rem;
    height: 2.4rem;
    pointer-events: auto;
    z-index: 30;
}

.gear-btn {
    position: absolute;
    top: 6px;
    right: 6px;
    height: 28px;
    min-width: 28px;
    padding: 0 8px;
    border-radius: 6px;
    border: 1px solid #333;
    background: #111;
    color: #eee;
    cursor: pointer;
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
    transition: opacity 120ms ease, background 120ms ease, border-color 120ms ease, transform 60ms ease;
    z-index: 31;
}

.stream-advanced-hotspot:hover .gear-btn {
    opacity: 1;
    visibility: visible;
    pointer-events: auto;
}

.gear-btn:hover {
    background: #1a1a1a;
    transform: translateY(-1px);
}

.slide-fade-enter-active,
.slide-fade-leave-active {
    transition: opacity 180ms ease, transform 180ms ease;
}
.slide-fade-enter-from,
.slide-fade-leave-to {
    opacity: 0;
    transform: translateY(-6px);
}

/* Collapsible sections (mouse + health) */
.collapse-enter-active,
.collapse-leave-active {
    transition: max-height 180ms ease, opacity 180ms ease;
    overflow: hidden;
}
.collapse-enter-from,
.collapse-leave-to {
    max-height: 0;
    opacity: 0;
}
.collapse-enter-to,
.collapse-leave-from {
    max-height: 2000px;
    opacity: 1;
}

.section-toggle {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--panel-fg);
    cursor: pointer;
    user-select: none;
    text-align: left;
}
.section-chev {
    display: inline-block;
    transform-origin: center;
    transition: transform 120ms ease;
}
.section-chev[data-open='false'] {
    transform: rotate(-90deg);
}

.controls-panel {
    display: flex;
    flex-direction: column;
    gap: 8px;

    /* Scroll only the advanced settings panel (⚙️ menu), not the whole pane */
    max-height: 55%;
    overflow: auto;              /* vertical + horizontal if needed */
    overscroll-behavior: contain; /* prevent wheel from “falling through” */
    scrollbar-gutter: stable;     /* avoid layout shift when scrollbar appears */
    padding-right: 6px;           /* keep content off the scrollbar */
}

.toolbar {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: center;
    gap: 8px;
    font-size: 14px;
}

.panel-text span {
    color: var(--panel-fg);
}

.toolbar .left {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
}

.toolbar .controls {
    --control-h: 30px;
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
}

.select {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: var(--control-h);
    padding: 0 8px;
    background: #0b0b0b;
    border: 1px solid #333;
    border-radius: 6px;
}
.select select {
    background: #0b0b0b;
    color: var(--panel-fg);
    border: 1px solid #333;
    border-radius: 6px;
    padding: 0 8px;
    height: var(--control-h);
    line-height: var(--control-h);
}

.input {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: var(--control-h);
    padding: 0 8px;
    background: #0b0b0b;
    border: 1px solid #333;
    border-radius: 6px;
}
.input input {
    width: 92px;
    background: #0b0b0b;
    color: var(--panel-fg);
    border: 1px solid #333;
    border-radius: 6px;
    padding: 0 8px;
    height: var(--control-h);
    line-height: var(--control-h);
}
.input[data-disabled='true'] {
    opacity: 0.55;
}

.checkbox.panel {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: var(--control-h);
    padding: 0 8px;
    background: #0b0b0b;
    border: 1px solid #333;
    border-radius: 6px;
}
.checkbox input {
    width: 16px;
    height: 16px;
}
.checkbox span {
    line-height: var(--control-h);
    color: var(--panel-fg);
}

.health-panel {
    margin-top: 4px;
    padding: 6px 8px;
    border-radius: 6px;
    border: 1px dashed #4b5563;
    background: #020617;
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 0.76rem;
    color: var(--panel-fg);
}

.health-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 6px;
}

.health-title {
    font-weight: 500;
    opacity: 0.9;
}

.health-meta {
    display: inline-flex;
    align-items: center;
    gap: 6px;
}

.health-pill {
    padding: 0 8px;
    border-radius: 999px;
    border: 1px solid #374151;
    font-size: 0.72rem;
    line-height: 1.4;
}

.health-pill--ok {
    border-color: #22c55e;
    background: #022c22;
}

.health-pill--loading {
    border-color: #38bdf8;
    background: #022c3a;
}

.health-pill--error {
    border-color: #ef4444;
    background: #450a0a;
}

.health-error {
    font-size: 0.74rem;
    color: #fecaca;
}

.health-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 4px 10px;
}

.health-row {
    display: flex;
    justify-content: space-between;
    gap: 6px;
}

.health-row .label {
    opacity: 0.7;
}

.health-row .value {
    text-align: right;
}

.health-note {
    opacity: 0.72;
    line-height: 1.35;
    font-size: 0.72rem;
}

.health-empty {
    opacity: 0.7;
}

.mouse-panel {
    --control-h: 30px;

    margin-top: 4px;
    padding: 8px 8px;
    border-radius: 6px;
    border: 1px dashed #334155;
    background: #020617;
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 0.76rem;
    color: var(--panel-fg);
}

.mouse-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 10px;
}

.mouse-title {
    font-weight: 600;
    opacity: 0.92;
}

.mouse-actions {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    justify-content: flex-end;
}

.mouse-btn {
    height: 28px;
    padding: 0 10px;
    border-radius: 6px;
    border: 1px solid #334155;
    background: #0b1120;
    color: var(--panel-fg);
    cursor: pointer;
    font-size: 0.76rem;
}
.mouse-btn:hover {
    background: #0f172a;
}
.mouse-btn--secondary {
    background: transparent;
    border-color: #475569;
}
.mouse-btn--secondary:hover {
    background: rgba(15, 23, 42, 0.35);
}

.mouse-subtitle {
    opacity: 0.82;
    font-weight: 500;
    margin-top: 2px;
}

.mouse-actions-note {
    opacity: 0.76;
    line-height: 1.35;
    margin-top: -2px;
    margin-bottom: 6px;
}
.mouse-actions-note code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
    font-size: 0.72rem;
}

.mouse-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
}
@media (max-width: 760px) {
    .mouse-grid {
        grid-template-columns: 1fr;
    }
}

.mouse-setting {
    border: 1px solid #1f2937;
    border-radius: 8px;
    background: rgba(2, 6, 23, 0.35);
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
}

.mouse-setting[data-disabled='true'] {
    opacity: 0.55;
}

.mouse-setting-name {
    font-weight: 600;
    opacity: 0.92;
}

.mouse-setting-control {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
}

.mouse-setting-control .select,
.mouse-setting-control .input,
.mouse-setting-control .checkbox.panel {
    flex: 1;
    min-width: 0;
}

/* Make inputs/selects grow within cards */
.mouse-setting-control .input input {
    width: 100%;
}
.mouse-setting-control .select select {
    width: 100%;
}

.mouse-default-btn {
    height: var(--control-h);
    padding: 0 10px;
    border-radius: 6px;
    border: 1px solid #475569;
    background: transparent;
    color: var(--panel-fg);
    cursor: pointer;
    font-size: 0.72rem;
    white-space: nowrap;
}
.mouse-default-btn:hover:not(:disabled) {
    background: rgba(15, 23, 42, 0.35);
}
.mouse-default-btn:disabled {
    opacity: 0.5;
    cursor: default;
}

.mouse-setting-desc {
    opacity: 0.76;
    line-height: 1.35;
    font-size: 0.72rem;
}
.mouse-setting-default {
    display: inline-block;
    margin-left: 6px;
    opacity: 0.9;
    font-weight: 500;
}

.mouse-note {
    opacity: 0.75;
    line-height: 1.35;
}
.mouse-note ul {
    margin: 6px 0 0 18px;
    padding: 0;
}

.viewport-stack {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
}

.viewport {
    position: relative;
    flex: 1;
    min-height: 0;
    background: #000;
    border: 1px solid #222;
    border-radius: 8px;
    padding: 4px;
    display: flex;
    align-items: stretch;
    justify-content: stretch;
}

.viewport[data-bg='pane'] {
    background: transparent;
    border-color: transparent;
}

.viewport-inner {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
}

.kb-capture-layer {
    position: relative;
    flex: 1;
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    outline: none;
    cursor: pointer;
    user-select: none;
    border-radius: 6px;
}

.stream-frame {
    position: relative;
    display: inline-flex;
    align-items: stretch;
    justify-content: stretch;
    background-color: #000;
    border-radius: 6px;
    overflow: hidden;
    flex: 0 0 auto;
}

.stream-img {
    display: block;
    position: relative;
    z-index: 1;
    width: 100%;
    height: 100%;
    border-radius: inherit;
    image-rendering: auto;
}

.stream-img[data-scale='fit'] {
    object-fit: contain;
}
.stream-img[data-scale='fill'] {
    object-fit: cover;
}
.stream-img[data-scale='stretch'] {
    object-fit: fill;
}
.stream-img[data-scale='native'] {
    object-fit: none;
}

.kb-glow {
    position: absolute;
    inset: 0;
    border-radius: inherit;
    pointer-events: none;
    opacity: 0;
    transition: opacity 120ms ease;
    background-image: linear-gradient(to bottom, rgba(var(--kb-accent-rgb), 0.75), rgba(var(--kb-accent-rgb), 0) 15px),
        linear-gradient(to top, rgba(var(--kb-accent-rgb), 0.75), rgba(var(--kb-accent-rgb), 0) 15px),
        linear-gradient(to right, rgba(var(--kb-accent-rgb), 0.75), rgba(var(--kb-accent-rgb), 0) 15px),
        linear-gradient(to left, rgba(var(--kb-accent-rgb), 0.75), rgba(var(--kb-accent-rgb), 0) 15px);
    background-repeat: no-repeat;
    background-size: 100% 15px, 100% 15px, 15px 100%, 15px 100%;
    background-position: top, bottom, left, right;
}

.stream-glow {
    z-index: 2;
}

.capture-glow {
    z-index: 3;
    border-radius: 6px;
}

.kb-capture-layer[data-capturing='true'] .stream-glow {
    opacity: 1;
}
.kb-capture-layer[data-capturing='true'] .capture-glow {
    opacity: 1;
}

.kb-overlay {
    position: absolute;
    left: 50%;
    top: 5px;
    bottom: auto;
    transform: translateX(-50%);
    pointer-events: none;
    z-index: 5;
}

.kb-overlay-inner {
    display: inline-flex;
    align-items: center;
    padding: 4px 10px;
    border-radius: 10px;
    border: 1px solid rgba(255, 255, 255, 0.16);
    background: rgba(2, 6, 23, 0.62);
    color: var(--panel-fg);
    font-size: 0.74rem;
    box-shadow: 0 6px 16px rgba(0, 0, 0, 0.22);
    backdrop-filter: blur(2px);
}

.viewport-placeholder {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
}
.placeholder-text {
    color: var(--panel-fg);
    font-size: 13px;
    opacity: 0.75;
}

.monospace {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
}

.frontpanel-leds {
    display: flex;
    align-items: center;
    gap: 8px;
    justify-content: flex-start;
    min-height: 0;
}

.frontpanel-leds--overlay {
    position: absolute;
    left: 8px;
    right: 8px;
    top: 8px;
    z-index: 6;
    pointer-events: none;
}

/* Right aligned (top-right + bottom-right) */
.frontpanel-leds[data-pos='top-right-h'],
.frontpanel-leds[data-pos='top-right-v'],
.frontpanel-leds[data-pos='bottom-right-h'],
.frontpanel-leds[data-pos='bottom-right-v'] {
    justify-content: flex-end;
}

/* Vertical stack: power above hdd */
.frontpanel-leds[data-pos='top-left-v'],
.frontpanel-leds[data-pos='top-left-v'] {
    align-items: flex-start;
}
.frontpanel-leds[data-pos='bottom-right-v'] {
    flex-direction: column;
    justify-content: flex-start;
}

/* For vertical stacks on the right, align the badges to the right edge */
.frontpanel-leds[data-pos='top-right-v'],
.frontpanel-leds[data-pos='bottom-right-v'] {
    align-items: flex-end;
}

/* Move overlay to bottom for bottom-right variants */
.frontpanel-leds--overlay[data-pos='bottom-right-h'],
.frontpanel-leds--overlay[data-pos='bottom-right-v'] {
    top: auto;
    bottom: 8px;
}

.fp-led-badge {
    --fp-led-rgb: 156, 163, 175;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 2px 10px;
    border-radius: 999px;
    border: 1px solid #374151;
    background: rgba(2, 6, 23, 0.72);
    color: var(--panel-fg);
    font-size: 0.74rem;
    line-height: 1.3;
    box-shadow: 0 6px 16px rgba(0, 0, 0, 0.22);
    backdrop-filter: blur(2px);
}

.fp-led-badge[data-kind='power'] {
    --fp-led-rgb: 34, 197, 94;
}

.fp-led-badge[data-kind='hdd'] {
    --fp-led-rgb: 249, 115, 22;
}

.fp-led-badge .dot {
    width: 8px;
    height: 8px;
    border-radius: 999px;
    display: inline-block;
    background: rgba(148, 163, 184, 0.25);
    opacity: 0.55;
    box-shadow: none;
    transform-origin: center;
}

.fp-led-badge[data-mode='on'] .dot {
    background: rgb(var(--fp-led-rgb));
    opacity: 1;
    box-shadow: 0 0 0 1px rgba(15, 23, 42, 0.9), 0 0 10px rgba(var(--fp-led-rgb), 0.35);
}

@keyframes fp-led-blink {
    0%,
    49% {
        opacity: 1;
    }
    50%,
    100% {
        opacity: 0.15;
    }
}

.fp-led-badge[data-mode='blink'] .dot,
.fp-led-badge[data-mode='blink-fast'] .dot {
    background: rgb(var(--fp-led-rgb));
    box-shadow: 0 0 0 1px rgba(15, 23, 42, 0.9), 0 0 10px rgba(var(--fp-led-rgb), 0.35);
    animation: fp-led-blink 1s steps(2, end) infinite;
}

.fp-led-badge[data-mode='blink-fast'] .dot {
    animation-duration: 350ms;
}

@keyframes fp-led-pulse {
    0% {
        opacity: 0.22;
        transform: scale(1);
    }
    50% {
        opacity: 1;
        transform: scale(1.35);
    }
    100% {
        opacity: 0.22;
        transform: scale(1);
    }
}

.fp-led-badge[data-mode='pulse'] .dot {
    background: rgb(var(--fp-led-rgb));
    box-shadow: 0 0 0 1px rgba(15, 23, 42, 0.9), 0 0 10px rgba(var(--fp-led-rgb), 0.35);
    animation: fp-led-pulse 900ms ease-in-out infinite;
    opacity: 1;
}

.frontpanel-controls {
    display: flex;
    align-items: center;
    gap: 8px;
    justify-content: flex-start;
    min-height: 0;
}
.frontpanel-controls[data-pos='bottom-right'] {
    justify-content: flex-end;
}

.frontpanel-controls--overlay {
    position: absolute;
    left: 8px;
    right: 8px;
    bottom: 8px;
    z-index: 6;
    pointer-events: none;
}
.frontpanel-controls--overlay .fp-btn {
    pointer-events: auto;
}

.fp-btn {
    --control-h: 28px;

    height: var(--control-h);
    line-height: var(--control-h);
    padding: 0 10px;
    border-radius: 6px;
    border: 1px solid #374151;
    background: #020617;
    color: var(--panel-fg);
    cursor: pointer;
    font-size: 0.76rem;
    font-weight: 500;
    text-align: center;
    transition: background 120ms ease, border-color 120ms ease, transform 60ms ease, box-shadow 120ms ease,
        opacity 120ms ease;
    user-select: none;
    white-space: nowrap;
}

.fp-btn:hover:not(:disabled) {
    background: #030712;
    border-color: #4b5563;
    transform: translateY(-1px);
}

.fp-btn:disabled {
    opacity: 0.5;
    cursor: default;
}

.fp-btn[data-held='true'] {
    border-color: #4b5563;
    background: #0b1120;
    box-shadow: none;
}
</style>
