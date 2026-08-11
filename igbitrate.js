// ==UserScript==
// @name         Instagram Call High-Bitrate Audio Injector
// @namespace    https://instagram.com/
// @version      1.0
// @description  Forces Opus audio encoder to 256kbps stereo CBR on Instagram Web calls.
// @author       You
// @match        https://www.instagram.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    const TARGET_BITRATE = 256000; // 256 kbps
    const TARGET_KBPS = 256;

    // Helper function to modify SDP parameters for Opus
    function upgradeOpusSdp(sdp) {
        let lines = sdp.split('\r\n');
        let opusPayloadType = null;

        // Find the Opus payload type
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes('a=rtpmap:') && lines[i].toLowerCase().includes('opus/48000')) {
                const match = lines[i].match(/a=rtpmap:(\d+)/);
                if (match) {
                    opusPayloadType = match[1];
                    break;
                }
            }
        }

        if (!opusPayloadType) return sdp; // Return original if Opus isn't found

        let fmtpFound = false;

        for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith(`a=fmtp:${opusPayloadType}`)) {
                fmtpFound = true;
                
                // Remove existing limits if present
                lines[i] = lines[i].replace(/maxaveragebitrate=\d+;?/g, '')
                                  .replace(/stereo=\d+;?/g, '')
                                  .replace(/sprop-stereo=\d+;?/g, '')
                                  .replace(/cbr=\d+;?/g, '')
                                  .replace(/usedtx=\d+;?/g, '');

                // Append custom high-quality parameters
                lines[i] += `;maxaveragebitrate=${TARGET_BITRATE};stereo=1;sprop-stereo=1;cbr=1;usedtx=0`;
            }
        }

        // If no fmtp line exists for Opus, append one manually
        if (!fmtpFound) {
            lines.push(`a=fmtp:${opusPayloadType} maxaveragebitrate=${TARGET_BITRATE};stereo=1;sprop-stereo=1;cbr=1;usedtx=0`);
        }

        // Apply media-level application bandwidth line (b=AS:256) under m=audio
        let inAudioSection = false;
        let modifiedLines = [];

        for (let i = 0; i < lines.length; i++) {
            modifiedLines.push(lines[i]);
            if (lines[i].startsWith('m=audio')) {
                inAudioSection = true;
                modifiedLines.push(`b=AS:${TARGET_KBPS}`);
            } else if (lines[i].startsWith('m=video')) {
                inAudioSection = false;
            }
        }

        return modifiedLines.join('\r\n');
    }

    // Intercept RTCPeerConnection API
    const OrigRTCPeerConnection = window.RTCPeerConnection;

    window.RTCPeerConnection = function(...args) {
        const pc = new OrigRTCPeerConnection(...args);

        const origSetLocalDescription = pc.setLocalDescription;
        pc.setLocalDescription = function(description) {
            if (description && description.sdp && description.type) {
                let modifiedSdp = upgradeOpusSdp(description.sdp);
                description = new RTCSessionDescription({
                    type: description.type,
                    sdp: modifiedSdp
                });
                console.log('[IG Audio Override] Forced Opus Encoder to 256kbps Stereo CBR');
            }
            return origSetLocalDescription.apply(this, [description]);
        };

        return pc;
    };

    window.RTCPeerConnection.prototype = OrigRTCPeerConnection.prototype;
})();
