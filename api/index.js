import express from 'express';
import { YoutubeTranscript } from 'youtube-transcript';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { ProxyAgent } from 'undici';

const require = createRequire(import.meta.url);
const { getSubtitles } = require('youtube-captions-scraper');

const app = express();

/* ── Proxy Loader Helpers ───────────────────────────────── */
async function getProxies() {
  const proxies = [];

  // 1. Try from environment variable PROXIES or PROXY_LIST
  if (process.env.PROXIES) {
    const list = process.env.PROXIES.split(',').map(p => p.trim()).filter(Boolean);
    proxies.push(...list);
  } else if (process.env.PROXY_LIST) {
    const list = process.env.PROXY_LIST.split(',').map(p => p.trim()).filter(Boolean);
    proxies.push(...list);
  }

  // 2. Try from local proxies.txt file
  try {
    const txtPath = path.join(process.cwd(), 'proxies.txt');
    if (fs.existsSync(txtPath)) {
      const content = fs.readFileSync(txtPath, 'utf8');
      const list = content.split('\n').map(p => p.trim()).filter(p => p && !p.startsWith('#'));
      proxies.push(...list);
    }
  } catch (err) {
    console.warn('[Proxy Loader] Error reading proxies.txt:', err.message);
  }

  return [...new Set(proxies)];
}

function createProxyAgent(proxyStr) {
  try {
    if (proxyStr.startsWith('http://') || proxyStr.startsWith('https://')) {
      return new ProxyAgent({ uri: proxyStr });
    }
    const parts = proxyStr.split(':');
    const ip = parts[0];
    const port = parts[1];
    const user = parts[2];
    const pass = parts[3];
    if (ip && port) {
      let proxyUrl = `http://${ip}:${port}`;
      if (user && pass) {
        proxyUrl = `http://${user}:${pass}@${ip}:${port}`;
      }
      return new ProxyAgent({ uri: proxyUrl });
    }
  } catch (error) {
    console.error('[ProxyAgent] Error creating agent:', error);
  }
  return undefined;
}

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
];

/* ── Direct page-scrape transcript fetcher (best for Vercel) ── */
async function fetchTranscriptDirect(videoId, agent) {
  const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

  const fetchOptions = {
    headers: {
      'User-Agent': ua,
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml',
    }
  };

  if (agent) {
    fetchOptions.dispatcher = agent;
  }

  // Step 1: Fetch the YouTube video page
  const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, fetchOptions);

  if (!pageRes.ok) {
    throw new Error(`YouTube page returned ${pageRes.status}`);
  }

  const html = await pageRes.text();

  // Step 2: Extract captions data from the page
  const captionsMatch = html.match(/"captions":\s*(\{.*?"playerCaptionsTracklistRenderer".*?\})\s*,\s*"videoDetails"/s);
  if (!captionsMatch) {
    // Check if captions are disabled
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
  const captionOptions = {
    headers: { 'User-Agent': ua }
  };
  if (agent) {
    captionOptions.dispatcher = agent;
  }
  const captionRes = await fetch(captionUrl, captionOptions);

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
}

/* ── Transcript API ─────────────────────────────────────── */
app.get('/api/transcript', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ success: false, error: 'URL required' });

    const videoId = extractVideoId(url);
    if (!videoId) return res.status(400).json({ success: false, error: 'Invalid YouTube URL. Please paste a valid YouTube link or video ID.' });

    // Load proxies and shuffle
    const proxies = await getProxies();
    const shuffledProxies = [...proxies].sort(() => Math.random() - 0.5);

    // 1. Fetch Metadata
    let [title, author] = ['Untitled Video', 'Unknown Channel'];
    const tryFetchMetadata = async (agent) => {
      const fetchOptions = {};
      if (agent) {
        fetchOptions.dispatcher = agent;
      }
      const oembedRes = await fetch(
        `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
        fetchOptions
      );
      if (oembedRes.ok) {
        return await oembedRes.json();
      }
      throw new Error(`oEmbed failed with status ${oembedRes.status}`);
    };

    let metadata = null;
    const maxMetadataProxyAttempts = Math.min(3, shuffledProxies.length);
    for (let i = 0; i < maxMetadataProxyAttempts; i++) {
      try {
        const agent = createProxyAgent(shuffledProxies[i]);
        if (agent) {
          metadata = await tryFetchMetadata(agent);
          if (metadata) break;
        }
      } catch (err) {
        console.warn(`[Metadata Proxy Attempt failed]: ${err.message}`);
      }
    }

    if (!metadata) {
      try {
        metadata = await tryFetchMetadata(undefined);
      } catch (err) {
        console.warn(`[Metadata WITHOUT proxy failed]: ${err.message}`);
      }
    }

    if (metadata) {
      title = metadata.title || title;
      author = metadata.author_name || author;
    }

    // 2. Try fetching transcript — 3 methods with fallbacks
    let transcript = null;
    let errorMsg = '';
    let lastDirectError = null;

    // Method 1: Direct page scrape (most reliable with proxy)
    const maxDirectProxyAttempts = Math.min(3, shuffledProxies.length);
    for (let i = 0; i < maxDirectProxyAttempts; i++) {
      try {
        const proxyStr = shuffledProxies[i];
        const proxyIp = proxyStr.split(':')[0];
        console.log(`[Method 1 - Direct] Trying proxy: ${proxyIp}`);
        const agent = createProxyAgent(proxyStr);
        if (agent) {
          transcript = await fetchTranscriptDirect(videoId, agent);
          if (transcript && transcript.length > 0) break;
        }
      } catch (err) {
        console.warn(`[Method 1 - Direct] Proxy attempt ${i+1} failed: ${err.message}`);
        lastDirectError = err;
      }
    }

    // Try direct page scrape WITHOUT proxy if proxy fails or no proxies available
    if (!transcript) {
      try {
        console.log(`[Method 1 - Direct] Trying WITHOUT proxy`);
        transcript = await fetchTranscriptDirect(videoId, undefined);
      } catch (err1) {
        console.warn(`[Method 1 - Direct] Failed WITHOUT proxy: ${err1.message}`);
        lastDirectError = err1;

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
      }
    }

    // Determine error from Method 1's error (most informative)
    if (!transcript) {
      const msg = lastDirectError?.message || '';
      if (msg === 'CAPTIONS_DISABLED') {
        errorMsg = 'Transcripts are disabled for this video.';
      } else if (msg === 'VIDEO_UNAVAILABLE') {
        errorMsg = 'This video is unavailable or does not exist.';
      } else if (msg === 'CAPTIONS_NOT_AVAILABLE' || msg === 'CAPTIONS_EMPTY') {
        errorMsg = 'No captions/transcript available for this video.';
      } else if (msg.includes('429') || msg.includes('Too many')) {
        errorMsg = 'YouTube is rate-limiting requests. Please try again later or configure proxies.';
      } else {
        errorMsg = 'Could not extract transcript. YouTube may be blocking this server.';
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
