// ==UserScript==
// @name         Instagram WebRTC Stream & Audio Max Power
// @namespace    https://www.instagram.com/
// @version      1.0
// @description  Overrides WebRTC constraints and munges SDP for max Opus audio bitrate (510 kbps, CBR, no DTX/FEC) and forced 1080p30 screen share.
// @author       Custom
// @match        https://www.instagram.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // Target audio parameters
    const TARGET_AUDIO_BITRATE = 510000; // 510 kbps

    // --- 1. SDP MUNGING FUNCTION FOR OPUS ---
    function enforceOpusParams(sdp) {
        if (!sdp) return sdp;

        const lines = sdp.split('\r\n');
        let opusPayloadType = null;

        // Find the payload type number assigned to Opus
        for (let i = 0; i < lines.length; i++) {
            const match = lines[i].match(/^a=rtpmap:(\d+)\s+opus\/48000\/2/i);
            if (match) {
                opusPayloadType = match[1];
                break;
            }
        }

        if (!opusPayloadType) return sdp;

        // Modify or append fmtp parameters for the identified Opus payload type
        let fmtpFound = false;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith(`a=fmtp:${opusPayloadType}`)) {
                fmtpFound = true;
                
                // Parse existing params or create new set
                let existingFmtp = lines[i].substring(`a=fmtp:${opusPayloadType} `.length);
                let paramMap = new Map();

                existingFmtp.split(';').forEach(p => {
                    const [key, val] = p.trim().split('=');
                    if (key) paramMap.set(key.trim(), val ? val.trim() : '');
                });

                // Override parameters according to specified configuration
                paramMap.set('maxaveragebitrate', TARGET_AUDIO_BITRATE.toString());
                paramMap.set('stereo', '1');
                paramMap.set('sprop-stereo', '1');
                paramMap.set('cbr', '1');              // Constant Bit Rate
                paramMap.set('usedtx', '0');           // Disable Discontinuous Transmission
                paramMap.set('useinbandfec', '0');     // Disable Forward Error Correction
                paramMap.set('maxplaybackrate', '48000');

                // Reconstruct fmtp line
                const newFmtp = Array.from(paramMap.entries())
                    .map(([k, v]) => `${k}=${v}`)
                    .join(';');

                lines[i] = `a=fmtp:${opusPayloadType} ${newFmtp}`;
                break;
            }
        }

        // If no fmtp line existed for Opus, inject one
        if (!fmtpFound) {
            const fmtpLine = `a=fmtp:${opusPayloadType} maxaveragebitrate=${TARGET_AUDIO_BITRATE};stereo=1;sprop-stereo=1;cbr=1;usedtx=0;useinbandfec=0;maxplaybackrate=48000`;
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].startsWith(`a=rtpmap:${opusPayloadType}`)) {
                    lines.splice(i + 1, 0, fmtpLine);
                    break;
                }
            }
        }

        return lines.join('\r\n');
    }

    // --- 2. INTERCEPT RTCPeerConnection ---
    const OriginalRTCPeerConnection = window.RTCPeerConnection;

    window.RTCPeerConnection = function (...args) {
        const pc = new OriginalRTCPeerConnection(...args);

        // Intercept setLocalDescription
        const originalSetLocalDescription = pc.setLocalDescription;
        pc.setLocalDescription = function (description) {
            if (description && description.sdp) {
                description = new RTCSessionDescription({
                    type: description.type,
                    sdp: enforceOpusParams(description.sdp)
                });
            }
            return originalSetLocalDescription.call(this, description);
        };

        // Intercept setRemoteDescription
        const originalSetRemoteDescription = pc.setRemoteDescription;
        pc.setRemoteDescription = function (description) {
            if (description && description.sdp) {
                description = new RTCSessionDescription({
                    type: description.type,
                    sdp: enforceOpusParams(description.sdp)
                });
            }
            return originalSetRemoteDescription.call(this, description);
        };

        // Force maxBitrate on Senders via RTCRtpSender.setParameters
        const originalAddTrack = pc.addTrack;
        pc.addTrack = function (...addTrackArgs) {
            const sender = originalAddTrack.apply(this, addTrackArgs);
            if (sender && sender.track) {
                setTimeout(async () => {
                    try {
                        const params = sender.getParameters();
                        if (!params.encodings || params.encodings.length === 0) {
                            params.encodings = [{}];
                        }
                        
                        if (sender.track.kind === 'audio') {
                            params.encodings.forEach(enc => {
                                enc.maxBitrate = TARGET_AUDIO_BITRATE;
                                enc.dtx = 'disabled';
                            });
                        } else if (sender.track.kind === 'video') {
                            params.encodings.forEach(enc => {
                                enc.maxBitrate = 8000000; // 8 Mbps max for 1080p screenshare
                                enc.degradationPreference = 'maintain-framerate';
                            });
                        }
                        await sender.setParameters(params);
                    } catch (e) {
                        console.warn('[WebRTC Mod] Error setting sender parameters:', e);
                    }
                }, 500);
            }
            return sender;
        };

        return pc;
    };

    window.RTCPeerConnection.prototype = OriginalRTCPeerConnection.prototype;

    // --- 3. INTERCEPT MEDIA CAPTURE CONSTRAINTS ---
    if (navigator.mediaDevices) {
        // Enforce 1080p30 for Display / Screen Sharing
        if (navigator.mediaDevices.getDisplayMedia) {
            const originalGetDisplayMedia = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
            navigator.mediaDevices.getDisplayMedia = function (constraints) {
                const forcedConstraints = {
                    video: {
                        width: { ideal: 1920, max: 1920 },
                        height: { ideal: 1080, max: 1080 },
                        frameRate: { ideal: 30, max: 30 },
                        displaySurface: 'monitor'
                    },
                    audio: {
                        echoCancellation: false,
                        noiseSuppression: false,
                        autoGainControl: false,
                        sampleRate: 48000,
                        channelCount: 2
                    }
                };
                return originalGetDisplayMedia(Object.assign({}, constraints, forcedConstraints));
            };
        }

        // Optimize User Audio input
        if (navigator.mediaDevices.getUserMedia) {
            const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
            navigator.mediaDevices.getUserMedia = function (constraints) {
                if (constraints && constraints.audio) {
                    if (typeof constraints.audio === 'object') {
                        constraints.audio.sampleRate = { ideal: 48000 };
                        constraints.audio.channelCount = { ideal: 2 };
                    }
                }
                return originalGetUserMedia(constraints);
            };
        }
    }

    console.log('[WebRTC Engine Overrider] Active on Instagram.');
})();
