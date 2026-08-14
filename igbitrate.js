// ==UserScript==
// @name         Instagram Call Max Quality Injector (510k Audio + 60fps Video)
// @namespace    https://instagram.com/
// @version      4.0
// @description  Overrides Audio (510kbps) and Video/Screenshare FPS (60fps) in WebRTC SDPs.
// @author       You
// @match        https://www.instagram.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // Target Settings
    const AUDIO_BITRATE = 510000;  // 510 kbps
    const AUDIO_KBPS = 510;
    const AUDIO_SAMPLE_RATE = 48000;

    const VIDEO_FPS = 60;           // Target 60 FPS for Video/Screenshare
    const VIDEO_KBPS = 6000;        // 6 Mbps bandwidth allocation for video
    const VIDEO_BITRATE = 6000000;

    function modifySDP(sdp) {
        if (!sdp) return sdp;

        let lines = sdp.split('\r\n');
        let currentMediaType = null; // 'audio' or 'video'

        for (let i = 0; i < lines.length; i++) {
            // Detect media section
            if (lines[i].startsWith('m=audio')) {
                currentMediaType = 'audio';
            } else if (lines[i].startsWith('m=video')) {
                currentMediaType = 'video';
            }

            // --- AUDIO MODIFICATIONS ---
            if (currentMediaType === 'audio') {
                if (lines[i].startsWith('a=fmtp:') && lines[i].toLowerCase().includes('maxaveragebitrate')) {
                    // Strip server limits and enforce max bandwidth + stereo
                    lines[i] = lines[i].replace(/maxaveragebitrate=\d+;?/g, '')
                                      .replace(/maxplaybackrate=\d+;?/g, '')
                                      .replace(/stereo=\d+;?/g, '')
                                      .replace(/sprop-stereo=\d+;?/g, '')
                                      .replace(/cbr=\d+;?/g, '')
                                      .replace(/usedtx=\d+;?/g, '')
                                      .replace(/;\s*$/, '');

                    lines[i] += `;maxaveragebitrate=${AUDIO_BITRATE};maxplaybackrate=${AUDIO_SAMPLE_RATE};stereo=1;sprop-stereo=1;cbr=1;usedtx=0`;
                }
            }

            // --- VIDEO / SCREENSHARE MODIFICATIONS ---
            if (currentMediaType === 'video') {
                if (lines[i].startsWith('a=fmtp:')) {
                    // Inject max-fr (framerate) parameter into video codecs if not present
                    if (!lines[i].includes('max-fr=')) {
                        lines[i] += `;max-fr=${VIDEO_FPS}`;
                    } else {
                        lines[i] = lines[i].replace(/max-fr=\d+/g, `max-fr=${VIDEO_FPS}`);
                    }
                }
            }
        }

        // Re-build SDP and inject transport bandwidth caps (b=AS / b=TIAS)
        let modifiedLines = [];
        currentMediaType = null;

        for (let i = 0; i < lines.length; i++) {
            modifiedLines.push(lines[i]);

            if (lines[i].startsWith('m=audio')) {
                modifiedLines.push(`b=AS:${AUDIO_KBPS}`);
                modifiedLines.push(`b=TIAS:${AUDIO_BITRATE}`);
            } else if (lines[i].startsWith('m=video')) {
                modifiedLines.push(`b=AS:${VIDEO_KBPS}`);
                modifiedLines.push(`b=TIAS:${VIDEO_BITRATE}`);
                modifiedLines.push(`a=framerate:${VIDEO_FPS}`);
            }
        }

        return modifiedLines.join('\r\n');
    }

    // Intercept WebRTC PeerConnection
    const OrigRTCPeerConnection = window.RTCPeerConnection;

    window.RTCPeerConnection = function(...args) {
        const pc = new OrigRTCPeerConnection(...args);

        const origSetLocalDescription = pc.setLocalDescription;
        pc.setLocalDescription = function(description) {
            if (description && description.sdp) {
                description = new RTCSessionDescription({
                    type: description.type,
                    sdp: modifySDP(description.sdp)
                });
                console.log('[WebRTC Injector] Local SDP modified (510k Audio / 60fps Video).');
            }
            return origSetLocalDescription.apply(this, [description]);
        };

        const origSetRemoteDescription = pc.setRemoteDescription;
        pc.setRemoteDescription = function(description) {
            if (description && description.sdp) {
                description = new RTCSessionDescription({
                    type: description.type,
                    sdp: modifySDP(description.sdp)
                });
                console.log('[WebRTC Injector] Remote SDP Offer overridden.');
            }
            return origSetRemoteDescription.apply(this, [description]);
        };

        return pc;
    };

    window.RTCPeerConnection.prototype = OrigRTCPeerConnection.prototype;
})();
