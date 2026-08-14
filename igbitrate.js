// ==UserScript==
// @name         IG WebRTC Max Quality Request (Local + Remote)
// @namespace    https://www.instagram.com/
// @version      1.0
// @description  Requests max Opus quality both locally and in remote SDP; forces high-quality capture.
// @match        https://www.instagram.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const TARGET_AUDIO_BITRATE = 510000;   // request ~510 kbps
    const TARGET_VIDEO_BITRATE = 8000000;  // request ~8 Mbps

    function enforceOpusParams(sdp, forRemote = false) {
        if (!sdp || typeof sdp !== 'string') return sdp;

        const lines = sdp.split('\r\n');
        let opusPt = null;

        for (let i = 0; i < lines.length; i++) {
            const m = lines[i].match(/^a=rtpmap:(\d+)\s+opus\/48000\/2/i);
            if (m) {
                opusPt = m[1];
                break;
            }
        }
        if (!opusPt) return sdp;

        let fmtpFound = false;

        for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith(`a=fmtp:${opusPt}`)) {
                fmtpFound = true;
                const existing = lines[i].substring(`a=fmtp:${opusPt} `.length);
                const paramMap = new Map();

                existing.split(';').forEach(p => {
                    const [k, v] = p.trim().split('=');
                    if (k) paramMap.set(k.trim(), v ? v.trim() : '');
                });

                // Request best quality
                paramMap.set('maxaveragebitrate', TARGET_AUDIO_BITRATE.toString());
                paramMap.set('stereo', '1');
                paramMap.set('sprop-stereo', '1');
                paramMap.set('cbr', '1');
                paramMap.set('usedtx', forRemote ? '0' : '0');       // ask remote to avoid DTX too
                paramMap.set('useinbandfec', '1');                   // request FEC if they support it
                paramMap.set('maxplaybackrate', '48000');
                paramMap.set('minptime', '10');

                const newFmtp = Array.from(paramMap.entries())
                    .map(([k, v]) => `${k}=${v}`)
                    .join(';');

                lines[i] = `a=fmtp:${opusPt} ${newFmtp}`;
                break;
            }
        }

        if (!fmtpFound) {
            const fmtpLine =
                `a=fmtp:${opusPt} maxaveragebitrate=${TARGET_AUDIO_BITRATE};` +
                `stereo=1;sprop-stereo=1;cbr=1;usedtx=0;useinbandfec=1;` +
                `maxplaybackrate=48000;minptime=10`;
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].startsWith(`a=rtpmap:${opusPt}`)) {
                    lines.splice(i + 1, 0, fmtpLine);
                    break;
                }
            }
        }

        // Optional: add bandwidth line to m=audio
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith('m=audio')) {
                const hasB = lines.some(l => l.startsWith('b=AS:'));
                if (!hasB) {
                    lines.splice(i + 1, 0, `b=AS:${Math.round(TARGET_AUDIO_BITRATE / 1000)}`);
                }
                break;
            }
        }

        return lines.join('\r\n');
    }

    const OriginalRTCPeerConnection = window.RTCPeerConnection;
    if (!OriginalRTCPeerConnection) return;

    function wrapPC(...args) {
        const pc = new OriginalRTCPeerConnection(...args);

        const origSetLocal = pc.setLocalDescription.bind(pc);
        pc.setLocalDescription = function (desc) {
            try {
                if (desc && desc.sdp) {
                    desc = new RTCSessionDescription({
                        type: desc.type,
                        sdp: enforceOpusParams(desc.sdp, false)
                    });
                }
            } catch (e) {
                console.warn('[IG MaxQ] setLocalDescription error:', e);
            }
            return origSetLocal(desc);
        };

        const origSetRemote = pc.setRemoteDescription.bind(pc);
        pc.setRemoteDescription = function (desc) {
            try {
                if (desc && desc.sdp) {
                    // Request best quality from remote side too
                    desc = new RTCSessionDescription({
                        type: desc.type,
                        sdp: enforceOpusParams(desc.sdp, true)
                    });
                }
            } catch (e) {
                console.warn('[IG MaxQ] setRemoteDescription error:', e);
            }
            return origSetRemote(desc);
        };

        async function tuneSender(sender) {
            try {
                const params = sender.getParameters() || {};
                if (!params.encodings || params.encodings.length === 0) {
                    params.encodings = [{}];
                }

                params.encodings.forEach(enc => {
                    if (sender.track && sender.track.kind === 'audio') {
                        enc.maxBitrate = TARGET_AUDIO_BITRATE;
                        enc.dtx = false;
                    } else if (sender.track && sender.track.kind === 'video') {
                        enc.maxBitrate = TARGET_VIDEO_BITRATE;
                        enc.degradationPreference = 'maintain-framerate';
                    }
                });

                await sender.setParameters(params);
            } catch (e) {
                console.warn('[IG MaxQ] tuneSender error:', e);
            }
        }

        const origAddTrack = pc.addTrack.bind(pc);
        pc.addTrack = function (...trackArgs) {
            const sender = origAddTrack(...trackArgs);
            if (sender) setTimeout(() => tuneSender(sender), 300);
            return sender;
        };

        if (pc.addTransceiver) {
            const origAddTransceiver = pc.addTransceiver.bind(pc);
            pc.addTransceiver = function (...txArgs) {
                const tx = origAddTransceiver(...txArgs);
                if (tx && tx.sender) setTimeout(() => tuneSender(tx.sender), 300);
                return tx;
            };
        }

        return pc;
    }

    window.RTCPeerConnection = wrapPC;
    window.RTCPeerConnection.prototype = OriginalRTCPeerConnection.prototype;

    // Capture-side: request best local quality
    if (navigator.mediaDevices) {
        if (navigator.mediaDevices.getUserMedia) {
            const origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
            navigator.mediaDevices.getUserMedia = function (constraints = {}) {
                if (!constraints.audio) return origGetUserMedia(constraints);

                if (typeof constraints.audio === 'boolean') {
                    constraints.audio = {};
                }

                const audio = constraints.audio;
                audio.echoCancellation = false;
                audio.noiseSuppression = false;
                audio.autoGainControl = false;
                audio.sampleRate = audio.sampleRate || { ideal: 48000 };
                audio.channelCount = audio.channelCount || { ideal: 2 };

                return origGetUserMedia(constraints);
            };
        }

        if (navigator.mediaDevices.getDisplayMedia) {
            const origGetDisplayMedia = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
            navigator.mediaDevices.getDisplayMedia = function (constraints = {}) {
                const forcedVideo = {
                    width: { ideal: 1920, max: 1920 },
                    height: { ideal: 1080, max: 1080 },
                    frameRate: { ideal: 30, max: 30 }
                };
                const forcedAudio = {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false,
                    sampleRate: 48000,
                    channelCount: 2
                };

                const merged = {
                    video: Object.assign({}, forcedVideo, constraints.video || {}),
                    audio: Object.assign({}, forcedAudio, constraints.audio || {})
                };

                return origGetDisplayMedia(merged);
            };
        }
    }

    console.log('[IG MaxQ] Local + remote quality request active.');
})();
