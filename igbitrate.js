// ==UserScript==
// @name         Instagram Call High-Bitrate Audio Injector (Bi-Directional Fix)
// @namespace    https://instagram.com/
// @version      3.0
// @description  Rewrites both Remote Offer and Local Answer to force 128kbps Opus audio.
// @author       You
// @match        https://www.instagram.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    const TARGET_BITRATE = 510000; // 128 kbps
    const TARGET_KBPS = 510;
    const MAX_PLAYBACK_RATE = 48000; // Fullband 48kHz

    // Helper to upgrade Opus settings in any SDP string
    function forceHighBitrateOpus(sdp) {
        if (!sdp) return sdp;

        let lines = sdp.split('\r\n');
        let opusPayloadType = null;

        // Locate Opus Payload ID
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes('a=rtpmap:') && lines[i].toLowerCase().includes('opus/48000')) {
                const match = lines[i].match(/a=rtpmap:(\d+)/);
                if (match) {
                    opusPayloadType = match[1];
                    break;
                }
            }
        }

        if (!opusPayloadType) return sdp;

        // Modify or replace a=fmtp lines for Opus
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith(`a=fmtp:${opusPayloadType}`)) {
                // Strip existing bandwidth restrictions set by IG server
                lines[i] = lines[i].replace(/maxaveragebitrate=\d+;?/g, '')
                                  .replace(/maxplaybackrate=\d+;?/g, '')
                                  .replace(/stereo=\d+;?/g, '')
                                  .replace(/sprop-stereo=\d+;?/g, '')
                                  .replace(/cbr=\d+;?/g, '')
                                  .replace(/usedtx=\d+;?/g, '')
                                  .replace(/;\s*$/, '');

                lines[i] += `;maxaveragebitrate=${TARGET_BITRATE};maxplaybackrate=${MAX_PLAYBACK_RATE};stereo=1;sprop-stereo=1;cbr=1;usedtx=0`;
            }
        }

        // Inject transport-level bandwidth limits under m=audio
        let modifiedLines = [];
        for (let i = 0; i < lines.length; i++) {
            modifiedLines.push(lines[i]);
            if (lines[i].startsWith('m=audio')) {
                modifiedLines.push(`b=AS:${TARGET_KBPS}`);
                modifiedLines.push(`b=TIAS:${TARGET_BITRATE}`);
            }
        }

        return modifiedLines.join('\r\n');
    }

    // Intercept RTCPeerConnection API
    const OrigRTCPeerConnection = window.RTCPeerConnection;

    window.RTCPeerConnection = function(...args) {
        const pc = new OrigRTCPeerConnection(...args);

        // 1. Intercept Local Description (What you tell the server you want to send)
        const origSetLocalDescription = pc.setLocalDescription;
        pc.setLocalDescription = function(description) {
            if (description && description.sdp) {
                description = new RTCSessionDescription({
                    type: description.type,
                    sdp: forceHighBitrateOpus(description.sdp)
                });
                console.log('[IG Audio Injector] Local SDP modified to 128kbps.');
            }
            return origSetLocalDescription.apply(this, [description]);
        };

        // 2. Intercept Remote Description (Unclamp Meta's server limits on your mic)
        const origSetRemoteDescription = pc.setRemoteDescription;
        pc.setRemoteDescription = function(description) {
            if (description && description.sdp) {
                description = new RTCSessionDescription({
                    type: description.type,
                    sdp: forceHighBitrateOpus(description.sdp)
                });
                console.log('[IG Audio Injector] Remote SDP Offer modified to accept 128kbps.');
            }
            return origSetRemoteDescription.apply(this, [description]);
        };

        return pc;
    };

    window.RTCPeerConnection.prototype = OrigRTCPeerConnection.prototype;
})();
