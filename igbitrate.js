// ==UserScript==
// @name         Instagram WebRTC Ultra-HQ Override (v4.0)
// @namespace    http://tampermonkey.net/
// @version      4.0
// @description  Forces 1080p@30fps, 12Mbps video bitrate, 510kbps stereo audio, and disables resolution downscaling on Instagram WebRTC streams.
// @author       You
// @match        https://www.instagram.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=instagram.com
// @grant        none
// @run-at       document-start
// ==UserScript==

(function () {
    'use strict';

    const TARGET_WIDTH = 1920;
    const TARGET_HEIGHT = 1080;
    const TARGET_FPS = 30;
    const VIDEO_MAX_BITRATE_BPS = 12000000; // 12 Mbps for zero blockiness
    const AUDIO_MAX_BITRATE_BPS = 510000;   // 510 kbps max Opus audio

    console.log('[HQ-WebRTC 4.0] Initializing High-Fidelity WebRTC Engine Interceptor...');

    // -------------------------------------------------------------
    // 1. Intercept media devices to demand raw 1080p @ 30fps
    // -------------------------------------------------------------
    const origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async function (constraints) {
        if (constraints && constraints.video) {
            console.log('[HQ-WebRTC 4.0] Overriding Video Constraints to 1080p 30fps...');
            constraints.video = {
                width: { exact: TARGET_WIDTH, ideal: TARGET_WIDTH },
                height: { exact: TARGET_HEIGHT, ideal: TARGET_HEIGHT },
                frameRate: { exact: TARGET_FPS, ideal: TARGET_FPS }
            };
        }

        if (constraints && constraints.audio) {
            console.log('[HQ-WebRTC 4.0] Enforcing Unprocessed Stereo Audio Capture...');
            constraints.audio = {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
                channelCount: 2,
                sampleRate: 48000
            };
        }

        return origGetUserMedia(constraints);
    };

    if (navigator.mediaDevices.getDisplayMedia) {
        const origGetDisplayMedia = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getDisplayMedia = async function (constraints) {
            if (constraints) {
                constraints.video = {
                    width: { ideal: TARGET_WIDTH, max: TARGET_WIDTH },
                    height: { ideal: TARGET_HEIGHT, max: TARGET_HEIGHT },
                    frameRate: { ideal: TARGET_FPS, max: TARGET_FPS }
                };
            }
            return origGetDisplayMedia(constraints);
        };
    }

    // -------------------------------------------------------------
    // 2. SDP Manging (Inject Bitrate Limits & Opus Stereo Ceiling)
    // -------------------------------------------------------------
    function optimizeSDP(sdp) {
        let lines = sdp.split('\r\n');
        let inVideo = false;

        for (let i = 0; i < lines.length; i++) {
            // Audio OPUS Parameter Injection
            if (lines[i].includes('a=fmtp:111')) {
                lines[i] = lines[i] + ';stereo=1;sprop-stereo=1;maxaveragebitrate=510000;cbr=1;maxplaybackrate=48000';
            }

            // Detect Video Section
            if (lines[i].startsWith('m=video')) {
                inVideo = true;
            } else if (lines[i].startsWith('m=audio') || lines[i].startsWith('m=application')) {
                inVideo = false;
            }

            // Inject TIAS Bandwidth Parameter under m=video
            if (inVideo && lines[i].startsWith('c=IN')) {
                lines.splice(i + 1, 0, `b=TIAS:${VIDEO_MAX_BITRATE_BPS}`);
                i++;
            }
        }
        return lines.join('\r\n');
    }

    // -------------------------------------------------------------
    // 3. Intercept PeerConnection to lock senders & maintain resolution
    // -------------------------------------------------------------
    const OrigPeerConnection = window.RTCPeerConnection;

    window.RTCPeerConnection = function (...args) {
        const pc = new OrigPeerConnection(...args);

        // Intercept Local & Remote Description calls for SDP modification
        const origSetLocalDescription = pc.setLocalDescription.bind(pc);
        pc.setLocalDescription = function (description) {
            if (description && description.sdp) {
                description.sdp = optimizeSDP(description.sdp);
            }
            return origSetLocalDescription(description);
        };

        const origSetRemoteDescription = pc.setRemoteDescription.bind(pc);
        pc.setRemoteDescription = function (description) {
            if (description && description.sdp) {
                description.sdp = optimizeSDP(description.sdp);
            }
            return origSetRemoteDescription(description);
        };

        // Enforce RTCRtpSender parameters on track negotiation
        pc.addEventListener('track', () => {
            applyHighQualitySenderParams(pc);
        });

        pc.addEventListener('connectionstatechange', () => {
            if (pc.connectionState === 'connected') {
                applyHighQualitySenderParams(pc);
            }
        });

        return pc;
    };

    window.RTCPeerConnection.prototype = OrigPeerConnection.prototype;

    async function applyHighQualitySenderParams(pc) {
        const senders = pc.getSenders();
        for (const sender of senders) {
            if (sender.track && sender.track.kind === 'video') {
                const params = sender.getParameters();
                if (!params.encodings || params.encodings.length === 0) {
                    params.encodings = [{}];
                }

                // Lock Max Bitrate & Prevent Quality/Resolution Lowering
                params.encodings[0].maxBitrate = VIDEO_MAX_BITRATE_BPS;
                params.encodings[0].maxFramerate = TARGET_FPS;
                params.degradationPreference = 'maintain-resolution';

                try {
                    await sender.setParameters(params);
                    console.log('[HQ-WebRTC 4.0] Successfully forced 12Mbps Bitrate & Maintain-Resolution on Video Sender.');
                } catch (e) {
                    console.warn('[HQ-WebRTC 4.0] Sender parameters update non-critical warning:', e);
                }
            }
        }
    }

})();
