// ==UserScript==
// @name         Instagram WebRTC Stream & Audio Max Power (Enhanced)
// @namespace    https://www.instagram.com/
// @version      2.0
// @description  Aggressive WebRTC override: max Opus audio bitrate (~510 kbps), CBR, no DTX/FEC, tuned constraints, and 1080p30 screenshare.
// @author       Custom
// @match        https://www.instagram.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const TARGET_AUDIO_BITRATE = 510000; // ~510 kbps
    const TARGET_VIDEO_BITRATE = 8000000; // 8 Mbps for 1080p screenshare

    // ---------- 1. SDP MUNGING FOR OPUS ----------
    function enforceOpusParams(sdp) {
        if (!sdp || typeof sdp !== 'string') return sdp;

        const lines = sdp.split('\r\n');
        let opusPayloadType = null;

        // Find Opus payload type
        for (let i = 0; i < lines.length; i++) {
            const match = lines[i].match(/^a=rtpmap:(\d+)\s+opus\/48000\/2/i);
            if (match) {
                opusPayloadType = match[1];
                break;
            }
        }

        if (!opusPayloadType) {
            return sdp; // No Opus, bail out safely
        }

        let fmtpFound = false;

        for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith(`a=fmtp:${opusPayloadType}`)) {
                fmtpFound = true;

                const existingFmtp = lines[i].substring(`a=fmtp:${opusPayloadType} `.length);
                const paramMap = new Map();

                existingFmtp.split(';').forEach(p => {
                    const [key, val] = p.trim().split('=');
                    if (key) paramMap.set(key.trim(), val ? val.trim() : '');
                });

                // Aggressive Opus tuning
                paramMap.set('maxaveragebitrate', TARGET_AUDIO_BITRATE.toString());
                paramMap.set('stereo', '1');
                paramMap.set('sprop-stereo', '1');
                paramMap.set('cbr', '1');
                paramMap.set('usedtx', '0');
                paramMap.set('useinbandfec', '0');
                paramMap.set('maxplaybackrate', '48000');

                const newFmtp = Array.from(paramMap.entries())
                    .map(([k, v]) => `${k}=${v}`)
                    .join(';');

                lines[i] = `a=fmtp:${opusPayloadType} ${newFmtp}`;
                break;
            }
        }

        if (!fmtpFound) {
            const fmtpLine =
                `a=fmtp:${opusPayloadType} ` +
                `maxaveragebitrate=${TARGET_AUDIO_BITRATE};` +
                `stereo=1;sprop-stereo=1;cbr=1;usedtx=0;useinbandfec=0;maxplaybackrate=48000`;

            for (let i = 0; i < lines.length; i++) {
                if (lines[i].startsWith(`a=rtpmap:${opusPayloadType}`)) {
                    lines.splice(i + 1, 0, fmtpLine);
                    break;
                }
            }
        }

        return lines.join('\r\n');
    }

    // ---------- 2. SAFE RTCPeerConnection WRAPPER ----------
    const OriginalRTCPeerConnection = window.RTCPeerConnection;

    if (!OriginalRTCPeerConnection) {
        console.warn('[WebRTC Mod] RTCPeerConnection not available.');
        return;
    }

    function wrapPeerConnection(...args) {
        const pc = new OriginalRTCPeerConnection(...args);

        // --- setLocalDescription ---
        const originalSetLocalDescription = pc.setLocalDescription.bind(pc);
        pc.setLocalDescription = function (description) {
            try {
                if (description && description.sdp) {
                    description = new RTCSessionDescription({
                        type: description.type,
                        sdp: enforceOpusParams(description.sdp)
                    });
                }
            } catch (e) {
                console.warn('[WebRTC Mod] setLocalDescription SDP munging error:', e);
            }
            return originalSetLocalDescription(description);
        };

        // --- setRemoteDescription ---
        const originalSetRemoteDescription = pc.setRemoteDescription.bind(pc);
        pc.setRemoteDescription = function (description) {
            try {
                if (description && description.sdp) {
                    description = new RTCSessionDescription({
                        type: description.type,
                        sdp: enforceOpusParams(description.sdp)
                    });
                }
            } catch (e) {
                console.warn('[WebRTC Mod] setRemoteDescription SDP munging error:', e);
            }
            return originalSetRemoteDescription(description);
        };

        // Helper: aggressively tune sender parameters
        async function tuneSender(sender) {
            try {
                const params = sender.getParameters() || {};
                if (!params.encodings || params.encodings.length === 0) {
                    params.encodings = [{}];
                }

                if (sender.track && sender.track.kind === 'audio') {
                    params.encodings.forEach(enc => {
                        enc.maxBitrate = TARGET_AUDIO_BITRATE;
                        enc.dtx = false; // boolean, not string
                    });
                } else if (sender.track && sender.track.kind === 'video') {
                    params.encodings.forEach(enc => {
                        enc.maxBitrate = TARGET_VIDEO_BITRATE;
                        enc.degradationPreference = 'maintain-framerate';
                    });
                }

                await sender.setParameters(params);
            } catch (e) {
                console.warn('[WebRTC Mod] Error tuning RTCRtpSender parameters:', e);
            }
        }

        // --- addTrack ---
        const originalAddTrack = pc.addTrack.bind(pc);
        pc.addTrack = function (...addTrackArgs) {
            const sender = originalAddTrack(...addTrackArgs);
            if (sender) {
                // Delay slightly to let browser populate parameters
                setTimeout(() => tuneSender(sender), 300);
            }
            return sender;
        };

        // --- addTransceiver (for modern pipelines) ---
        if (pc.addTransceiver) {
            const originalAddTransceiver = pc.addTransceiver.bind(pc);
            pc.addTransceiver = function (...txArgs) {
                const transceiver = originalAddTransceiver(...txArgs);
                if (transceiver && transceiver.sender) {
                    setTimeout(() => tuneSender(transceiver.sender), 300);
                }
                return transceiver;
            };
        }

        return pc;
    }

    window.RTCPeerConnection = wrapPeerConnection;
    window.RTCPeerConnection.prototype = OriginalRTCPeerConnection.prototype;

    // ---------- 3. MEDIA CONSTRAINTS OVERRIDES ----------
    if (navigator.mediaDevices) {
        // --- getDisplayMedia: force 1080p30 screenshare ---
        if (navigator.mediaDevices.getDisplayMedia) {
            const originalGetDisplayMedia =
                navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);

            navigator.mediaDevices.getDisplayMedia = function (constraints = {}) {
                const forcedVideo = {
                    width: { ideal: 1920, max: 1920 },
                    height: { ideal: 1080, max: 1080 },
                    frameRate: { ideal: 30, max: 30 },
                    displaySurface: 'monitor'
                };

                const forcedAudio = {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false,
                    sampleRate: 48000,
                    channelCount: 2
                };

                const mergedConstraints = {
                    video: Object.assign({}, forcedVideo, constraints.video || {}),
                    audio: Object.assign({}, forcedAudio, constraints.audio || {})
                };

                return originalGetDisplayMedia(mergedConstraints);
            };
        }

        // --- getUserMedia: tune audio input ---
        if (navigator.mediaDevices.getUserMedia) {
            const originalGetUserMedia =
                navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

            navigator.mediaDevices.getUserMedia = function (constraints = {}) {
                if (!constraints.audio) {
                    return originalGetUserMedia(constraints);
                }

                if (typeof constraints.audio === 'boolean') {
                    constraints.audio = {};
                }

                const audio = constraints.audio;

                audio.echoCancellation = false;
                audio.noiseSuppression = false;
                audio.autoGainControl = false;

                audio.sampleRate = audio.sampleRate || { ideal: 48000 };
                audio.channelCount = audio.channelCount || { ideal: 2 };

                return originalGetUserMedia(constraints);
            };
        }
    }

    console.log('[WebRTC Engine Overrider] Enhanced Instagram profile active.');
})();
