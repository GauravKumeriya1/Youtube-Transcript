import express from 'express';
import { YoutubeTranscript } from 'youtube-transcript';
import { createRequire } from 'module';
import { ProxyAgent } from 'undici';

const require = createRequire(import.meta.url);
const { getSubtitles } = require('youtube-captions-scraper');

const app = express();

const PROXY_LIST = [
  'http://ltctkkmj:m030l2q44zry@38.154.203.95:5863',
  'http://ltctkkmj:m030l2q44zry@198.105.121.200:6462',
  'http://ltctkkmj:m030l2q44zry@64.137.96.74:6641',
  'http://ltctkkmj:m030l2q44zry@209.127.138.10:5784',
  'http://ltctkkmj:m030l2q44zry@38.154.185.97:6370',
  'http://ltctkkmj:m030l2q44zry@84.247.60.125:6095',
  'http://ltctkkmj:m030l2q44zry@142.111.67.146:5611',
  'http://ltctkkmj:m030l2q44zry@191.96.254.138:6185',
  'http://ltctkkmj:m030l2q44zry@31.58.9.4:6077',
  'http://ltctkkmj:m030l2q44zry@64.137.10.153:5803'
];

function getRandomProxyAgent() {
  const url = PROXY_LIST[Math.floor(Math.random() * PROXY_LIST.length)];
  return new ProxyAgent(url);
}

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
];

async function fetchTranscriptDirect(videoId) {
  const shuffledProxies = [...PROXY_LIST].sort(() => Math.random() - 0.5);
  let lastError = null;

  for (const proxyUrl of shuffledProxies) {
    const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    const dispatcher = new ProxyAgent(proxyUrl);

    try {
      // Step 1: Fetch the YouTube video page
      const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
        headers: {
          'User-Agent': ua,
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept': 'text/html,application/xhtml+xml',
        },
        dispatcher
      });

      if (!pageRes.ok) {
        throw new Error(`YouTube page returned ${pageRes.status}`);
      }

      const html = await pageRes.text();

      // Step 2: Extract captions data from the page
      const captionsMatch = html.match(/"captions":\s*(\{.*?"playerCaptionsTracklistRenderer".*?\})\s*,\s*"videoDetails"/s);
      if (!captionsMatch) {
        if (html.includes('"playabilityStatus"') && html.includes('"reason"')) {
          throw new Error('VIDEO_UNAVAILABLE');
        }
        throw new Error('CAPTIONS_NOT_AVAILABLE');
      }

      let captionsData;
      try {
        captionsData = JSON.parse(captionsMatch[1]);
      } catch {
        throw new Error('CAPTIONS_PARSE_ERROR');
      }

      const tracks = captionsData?.playerCaptionsTracklistRenderer?.captionTracks;
      if (!tracks || tracks.length === 0) {
        throw new Error('CAPTIONS_DISABLED');
      }

      // Step 3: Find the best English track (prefer manual over auto-generated)
      let track = tracks.find(t => t.languageCode === 'en' && t.kind !== 'asr');
      if (!track) track = tracks.find(t => t.languageCode === 'en');
      if (!track) track = tracks.find(t => t.languageCode?.startsWith('en'));
      if (!track) track = tracks[0]; // fallback to first available

      // Step 4: Fetch the transcript XML from YouTube's timedtext CDN
      const captionUrl = track.baseUrl + '&fmt=json3';
      const captionRes = await fetch(captionUrl, {
        headers: { 'User-Agent': ua },
        dispatcher
      });

      if (!captionRes.ok) {
        throw new Error(`Caption fetch returned ${captionRes.status}`);
      }

      const captionData = await captionRes.json();
      const events = captionData?.events;
      if (!events || events.length === 0) {
        throw new Error('CAPTIONS_EMPTY');
      }

      // Step 5: Parse into our standard format
      const transcript = events
        .filter(e => e.segs && e.segs.length > 0)
        .map(e => ({
          text: e.segs.map(s => s.utf8).join('').trim(),
          offset: e.tStartMs || 0,
          duration: e.dDurationMs || 0,
          lang: track.languageCode
        }))
        .filter(t => t.text.length > 0);

      if (transcript.length === 0) {
        throw new Error('CAPTIONS_EMPTY');
      }

      return transcript;

    } catch (err) {
      console.warn(`Proxy ${proxyUrl.split('@')[1]} failed: ${err.message}`);
      lastError = err;
    }
  }

  throw lastError || new Error('All proxies failed');
}

/* ── Transcript API ─────────────────────────────────────── */
app.get('/api/transcript', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ success: false, error: 'URL required' });

    const videoId = extractVideoId(url);
    if (!videoId) return res.status(400).json({ success: false, error: 'Invalid YouTube URL. Please paste a valid YouTube link or video ID.' });

    // 1. Fetch Metadata
    let [title, author] = ['Untitled Video', 'Unknown Channel'];
    try {
      const oembedRes = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
      if (oembedRes.ok) {
        const info = await oembedRes.json();
        title = info.title || title;
        author = info.author_name || author;
      }
    } catch (err) {
      console.error('Metadata fetch error:', err.message);
    }

    // 2. Try fetching transcript — 3 methods with fallbacks
    let transcript = null;
    let errorMsg = '';

    // Method 1: Direct page scrape (most reliable on Vercel)
    try {
      console.log(`[Method 1 - Direct] Fetching ${videoId}`);
      transcript = await fetchTranscriptDirect(videoId);
    } catch (err1) {
      console.warn(`[Method 1 - Direct] Failed: ${err1.message}`);

      // Method 2: youtube-transcript library
      try {
        console.log(`[Method 2 - Library] Fetching ${videoId}`);
        transcript = await YoutubeTranscript.fetchTranscript(videoId, { lang: 'en' });
      } catch (err2) {
        console.warn(`[Method 2 - Library] Failed: ${err2.message}`);

        // Method 3: youtube-captions-scraper fallback
        const langs = ['en', 'en-US', 'en-GB'];
        for (const lang of langs) {
          try {
            console.log(`[Method 3 - Scraper] Trying lang=${lang} for ${videoId}`);
            const subs = await getSubtitles({ videoID: videoId, lang });
            if (subs && subs.length > 0) {
              transcript = subs.map(t => ({
                text: t.text,
                offset: parseFloat(t.start) * 1000,
                duration: parseFloat(t.dur) * 1000
              }));
              break;
            }
          } catch (err3) {
            console.warn(`[Method 3 - Scraper] lang=${lang} failed: ${err3.message}`);
          }
        }
      }

      // Determine error from Method 1's error (most informative)
      if (!transcript) {
        const msg = err1.message || '';
        if (msg === 'CAPTIONS_DISABLED') {
          errorMsg = 'Transcripts are disabled for this video.';
        } else if (msg === 'VIDEO_UNAVAILABLE') {
          errorMsg = 'This video is unavailable or does not exist.';
        } else if (msg === 'CAPTIONS_NOT_AVAILABLE' || msg === 'CAPTIONS_EMPTY') {
          errorMsg = 'No captions/transcript available for this video.';
        } else if (msg.includes('429') || msg.includes('Too many')) {
          errorMsg = 'YouTube is rate-limiting requests. Please try again later or run the app locally.';
        } else {
          errorMsg = 'Could not extract transcript. YouTube may be blocking this server — try running the app locally.';
        }
      }
    }

    return res.json({
      success: !!transcript,
      transcript: transcript || [],
      videoId,
      title,
      author,
      error: transcript ? null : errorMsg
    });

  } catch (unexpectedErr) {
    console.error('Unexpected error:', unexpectedErr);
    return res.status(500).json({
      success: false,
      error: 'An unexpected server error occurred. Please try again.'
    });
  }
});

function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?.*v=)([a-zA-Z0-9_-]{11})/,
    /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/live\/)([a-zA-Z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = url.trim().match(p);
    if (m) return m[1];
  }
  // Raw 11-char video ID
  if (/^[a-zA-Z0-9_-]{11}$/.test(url.trim())) return url.trim();
  return null;
}

export default app;
