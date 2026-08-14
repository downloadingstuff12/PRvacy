// ==UserScript==
// @name         Instagram WebRTC Audio/Video Max Quality Engine
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Forces 510kbps Opus CBR, locks 1080p30 screenshare, disables DTX/FEC, and enforces maximum bitrate on Instagram WebRTC calls.
// @match        https://www.instagram.com/*
// @run-at       document-start
// @grant        none
// ==UserScript==

(function () {
    'use strict';

    console.log('[WebRTC Engine Override] Initializing Instagram Max Quality Script...');

    // Configuration Constants
    const TARGET_AUDIO_BITRATE = 510000; // 510 kbps
    const TARGET_VIDEO_BITRATE = 8000000; // 8 Mbps for crisp 1080p
    const VIDEO_WIDTH = 1920;
    const VIDEO_HEIGHT = 1080;
    const VIDEO_FPS = 30;

    /**
     * Munges SDP strings to inject high-fidelity Opus parameters and video bandwidth limits.
     */
    function mungeSDP(sdp) {
        if (!sdp) return sdp;

        let lines = sdp.split('\r\n');
        let opusPayloadType = null;

        // 1. Locate Opus payload type
        for (let line of lines) {
            if (line.includes('a=rtpmap:') && line.toLowerCase().includes('opus/48000')) {
                const match = line.match(/a=rtpmap:(\d+)\s+opus\/48000/i);
                if (match) {
                    opusPayloadType = match[1];
                    break;
                }
            }
        }

        // 2. Modify or append Opus fmtp parameters
        if (opusPayloadType) {
            let fmtpFound = false;
            lines = lines.map(line => {
                if (line.startsWith(`a=fmtp:${opusPayloadType}`)) {
                    fmtpFound = true;
                    // Strip existing parameters and apply maximum target options
                    return `a=fmtp:${opusPayloadType} minptime=10;maxptime=60;stereo=1;sprop-stereo=1;maxaveragebitrate=${TARGET_AUDIO_BITRATE};cbr=1;usedtx=0;useinbandfec=0;maxplaybackrate=48000`;
                }
                return line;
            });

            if (!fmtpFound) {
                // If no fmtp line existed, insert it after the rtpmap line
                const rtpmapIdx = lines.findIndex(l => l.startsWith(`a=rtpmap:${opusPayloadType}`));
                if (rtpmapIdx !== -1) {
                    lines.splice(rtpmapIdx + 1, 0, `a=fmtp:${opusPayloadType} minptime=10;maxptime=60;stereo=1;sprop-stereo=1;maxaveragebitrate=${TARGET_AUDIO_BITRATE};cbr=1;usedtx=0;useinbandfec=0;maxplaybackrate=48000`);
                }
            }
        }

        // 3. Inject explicit media level bandwidth limits for Audio & Video
        let updatedLines = [];
        let currentMedia = null;

        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];
            
            if (line.startsWith('m=audio')) {
                currentMedia = 'audio';
            } else if (line.startsWith('m=video')) {
                currentMedia = 'video';
            } else if (line.startsWith('m=')) {
                currentMedia = 'other';
            }

            updatedLines.push(line);

            // Append AS/TIAS bandwidth lines after media definitions if missing
            if (line.startsWith('c=IN')) {
                if (currentMedia === 'audio') {
                    updatedLines.push(`b=AS:${Math.ceil(TARGET_AUDIO_BITRATE / 1000)}`);
                    updatedLines.push(`b=TIAS:${TARGET_AUDIO_BITRATE}`);
                } else if (currentMedia === 'video') {
                    updatedLines.push(`b=AS:${Math.ceil(TARGET_VIDEO_BITRATE / 1000)}`);
                    updatedLines.push(`b=TIAS:${TARGET_VIDEO_BITRATE}`);
                }
            }
        }

        return updatedLines.join('\r\n');
    }

    /**
     * Applies encoder-level parameters directly to active RTCRtpSenders.
     */
    async function applySenderParameters(pc) {
        const senders = pc.getSenders();
        for (let sender of senders) {
            if (!sender.track) continue;

            const parameters = sender.getParameters();
            if (!parameters.encodings || parameters.encodings.length === 0) {
                parameters.encodings = [{}];
            }

            if (sender.track.kind === 'audio') {
                parameters.encodings[0].maxBitrate = TARGET_AUDIO_BITRATE;
                parameters.encodings[0].networkPriority = 'high';
                parameters.encodings[0].priority = 'high';
                try {
                    await sender.setParameters(parameters);
                    console.log('[WebRTC Engine Override] Audio Sender maxBitrate applied:', TARGET_AUDIO_BITRATE);
                } catch (e) {
                    console.warn('[WebRTC Engine Override] Failed setting audio parameters:', e);
                }
            } else if (sender.track.kind === 'video') {
                parameters.encodings[0].maxBitrate = TARGET_VIDEO_BITRATE;
                parameters.encodings[0].maxFramerate = VIDEO_FPS;
                parameters.encodings[0].networkPriority = 'high';
                parameters.encodings[0].priority = 'high';
                
                // Forces Chromium to maintain resolution rather than degrading pixel quality
                parameters.degradationPreference = 'maintain-resolution';

                try {
                    await sender.setParameters(parameters);
                    console.log('[WebRTC Engine Override] Video Sender degradationPreference & maxBitrate applied:', TARGET_VIDEO_BITRATE);
                } catch (e) {
                    console.warn('[WebRTC Engine Override] Failed setting video parameters:', e);
                }
            }
        }
    }

    // --- RTCPeerConnection Interception ---
    const OriginalRTCPeerConnection = window.RTCPeerConnection;

    window.RTCPeerConnection = function (...args) {
        const pc = new OriginalRTCPeerConnection(...args);

        // Override setLocalDescription
        const origSetLocalDescription = pc.setLocalDescription.bind(pc);
        pc.setLocalDescription = function (description) {
            if (description && description.sdp) {
                description = new RTCSessionDescription({
                    type: description.type,
                    sdp: mungeSDP(description.sdp)
                });
                console.log('[WebRTC Engine Override] Munged Local SDP successfully.');
            }
            return origSetLocalDescription(description);
        };

        // Override setRemoteDescription
        const origSetRemoteDescription = pc.setRemoteDescription.bind(pc);
        pc.setRemoteDescription = function (description) {
            if (description && description.sdp) {
                description = new RTCSessionDescription({
                    type: description.type,
                    sdp: mungeSDP(description.sdp)
                });
                console.log('[WebRTC Engine Override] Munged Remote SDP successfully.');
            }
            return origSetRemoteDescription(description);
        };

        // Apply parameter enforcement once signaling reaches stable state
        pc.addEventListener('signalingstatechange', () => {
            if (pc.signalingState === 'stable') {
                applySenderParameters(pc);
            }
        });

        pc.addEventListener('iceconnectionstatechange', () => {
            if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
                applySenderParameters(pc);
            }
        });

        return pc;
    };

    window.RTCPeerConnection.prototype = OriginalRTCPeerConnection.prototype;

    // --- UserMedia & Screenshare Constraints Interception ---
    if (navigator.mediaDevices) {
        // Enforce raw, uncompressed 48kHz audio streams
        const origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = function (constraints) {
            if (constraints && constraints.audio) {
                if (typeof constraints.audio === 'boolean') {
                    constraints.audio = {};
                }
                constraints.audio.echoCancellation = false;
                constraints.audio.autoGainControl = false;
                constraints.audio.noiseSuppression = false;
                constraints.audio.channelCount = { ideal: 2 };
                constraints.audio.sampleRate = { ideal: 48000 };
                constraints.audio.sampleSize = { ideal: 16 };
            }
            return origGetUserMedia(constraints);
        };

        // Enforce exact 1080p @ 30 FPS screenshare constraints
        if (navigator.mediaDevices.getDisplayMedia) {
            const origGetDisplayMedia = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
            navigator.mediaDevices.getDisplayMedia = function (constraints) {
                const forcedConstraints = {
                    video: {
                        width: { ideal: VIDEO_WIDTH, max: VIDEO_WIDTH },
                        height: { ideal: VIDEO_HEIGHT, max: VIDEO_HEIGHT },
                        frameRate: { ideal: VIDEO_FPS, max: VIDEO_FPS },
                        displaySurface: 'monitor'
                    },
                    audio: constraints ? constraints.audio : false
                };
                console.log('[WebRTC Engine Override] Forcing 1080p30 DisplayMedia constraints:', forcedConstraints);
                return origGetDisplayMedia(forcedConstraints);
            };
        }
    }

})();
