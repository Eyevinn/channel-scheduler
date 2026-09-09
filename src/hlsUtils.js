const axios = require('axios');
const HLS = require('hls-parser');

// Duration detection result sources. Callers MUST use these to decide whether
// a duration is trustworthy enough to persist/schedule.
//   MEASURED  - summed from real segment durations; safe to store
//   ESTIMATED - guessed from targetDuration; usable but flagged as inexact
// Hard failures (unreachable/404/timeout/unparseable/no-variants/no-data) throw
// instead of returning a placeholder, so a dead manifest can never masquerade
// as a valid-looking asset.
const DURATION_SOURCE = {
  MEASURED: 'measured',
  ESTIMATED: 'estimated'
};

/**
 * Detect the duration of an HLS asset.
 *
 * @param {string} hlsUrl
 * @returns {Promise<{durationMs: number, source: string}>}
 *   source is one of DURATION_SOURCE.MEASURED | DURATION_SOURCE.ESTIMATED.
 * @throws {Error} on any hard detection failure (network, 404, timeout,
 *   unparseable manifest, master playlist with no variants, media playlist
 *   with no segments and no targetDuration). Callers must treat a thrown
 *   error as "duration unknown" and NOT persist a placeholder.
 */
async function getHLSDuration(hlsUrl) {
  console.log(`Fetching HLS manifest from: ${hlsUrl}`);

  const response = await axios.get(hlsUrl, {
    timeout: 10000,
    headers: {
      'User-Agent': 'Channel-Scheduler/1.0'
    }
  });

  const manifest = HLS.parse(response.data);

  if (manifest.isMasterPlaylist) {
    // If it's a master playlist, get the first variant and fetch its media playlist
    if (manifest.variants && manifest.variants.length > 0) {
      const variantUrl = new URL(manifest.variants[0].uri, hlsUrl).href;
      return await getHLSDuration(variantUrl);
    }
    throw new Error('Master playlist has no variants');
  }

  // Media playlist: prefer a real measurement from the segment list.
  if (manifest.segments && manifest.segments.length > 0) {
    let totalDuration = 0;
    for (const segment of manifest.segments) {
      totalDuration += segment.duration || 0;
    }
    const durationMs = Math.round(totalDuration * 1000);
    console.log(`Measured HLS duration: ${totalDuration}s (${durationMs}ms)`);
    return { durationMs, source: DURATION_SOURCE.MEASURED };
  }

  // No segments: we can only estimate from targetDuration. Flag it as an
  // ESTIMATE so callers can distinguish it from a real measurement.
  if (manifest.targetDuration) {
    const estimatedSegments = 10; // Default estimation
    const totalDuration = manifest.targetDuration * estimatedSegments;
    const durationMs = Math.round(totalDuration * 1000);
    console.warn(`No segments found, estimating duration: ${totalDuration}s (${durationMs}ms)`);
    return { durationMs, source: DURATION_SOURCE.ESTIMATED };
  }

  // Nothing usable in the manifest - this is a hard failure, not a placeholder.
  throw new Error('Media playlist has no segments and no targetDuration');
}

async function validateHLSUrl(hlsUrl) {
  try {
    const response = await axios.head(hlsUrl, {
      timeout: 5000,
      headers: {
        'User-Agent': 'Channel-Scheduler/1.0'
      }
    });
    
    const contentType = response.headers['content-type'] || '';
    return contentType.includes('application/vnd.apple.mpegurl') || 
           contentType.includes('application/x-mpegURL') ||
           hlsUrl.endsWith('.m3u8');
  } catch (error) {
    console.error('Error validating HLS URL:', error.message);
    return false;
  }
}

module.exports = {
  getHLSDuration,
  validateHLSUrl,
  DURATION_SOURCE
};