import express from 'express';
import { YoutubeTranscript } from 'youtube-transcript';
import path from 'path';
import { fileURLToPath } from 'url';
import { ProxyAgent } from 'undici';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3001;

app.use(express.static(path.join(__dirname, 'public')));

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
];

async function fetchTranscriptDirect(videoId) {
  const shuffledProxies = [...PROXY_LIST].sort(() => Math.random() - 0.5);
  let lastError = null;

  for (const proxyUrl of shuffledProxies) {
    const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    const dispatcher = new ProxyAgent(proxyUrl);

    try {
      const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
        headers: {
          'User-Agent': ua,
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept': 'text/html,application/xhtml+xml',
        },
        dispatcher
      });

      if (!pageRes.ok) throw new Error(`YouTube page returned ${pageRes.status}`);
      const html = await pageRes.text();

      const captionsMatch = html.match(/"captions":\s*(\{.*?"playerCaptionsTracklistRenderer".*?\})\s*,\s*"videoDetails"/s);
      if (!captionsMatch) {
        if (html.includes('"playabilityStatus"') && html.includes('"reason"')) {
          throw new Error('VIDEO_UNAVAILABLE');
        }
        throw new Error('CAPTIONS_NOT_AVAILABLE');
      }

      let captionsData;
      try { captionsData = JSON.parse(captionsMatch[1]); } catch { throw new Error('CAPTIONS_PARSE_ERROR'); }

      const tracks = captionsData?.playerCaptionsTracklistRenderer?.captionTracks;
      if (!tracks || tracks.length === 0) throw new Error('CAPTIONS_DISABLED');

      let track = tracks.find(t => t.languageCode === 'en' && t.kind !== 'asr');
      if (!track) track = tracks.find(t => t.languageCode === 'en');
      if (!track) track = tracks.find(t => t.languageCode?.startsWith('en'));
      if (!track) track = tracks[0];

      const captionRes = await fetch(track.baseUrl + '&fmt=json3', {
        headers: { 'User-Agent': ua },
        dispatcher
      });
      if (!captionRes.ok) throw new Error(`Caption fetch returned ${captionRes.status}`);

      const captionData = await captionRes.json();
      const events = captionData?.events;
      if (!events || events.length === 0) throw new Error('CAPTIONS_EMPTY');

      const transcript = events
        .filter(e => e.segs && e.segs.length > 0)
        .map(e => ({
          text: e.segs.map(s => s.utf8).join('').trim(),
          offset: e.tStartMs || 0,
          duration: e.dDurationMs || 0,
          lang: track.languageCode
        }))
        .filter(t => t.text.length > 0);

      if (transcript.length === 0) throw new Error('CAPTIONS_EMPTY');
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
    if (!url) {
      return res.status(400).json({ success: false, error: 'YouTube URL is required' });
    }

    const videoId = extractVideoId(url);
    if (!videoId) {
      return res.status(400).json({ success: false, error: 'Invalid YouTube URL' });
    }

    // Fetch video metadata via oEmbed
    let title = '', author = '';
    try {
      const canonical = `https://www.youtube.com/watch?v=${videoId}`;
      const oembedRes = await fetch(
        `https://www.youtube.com/oembed?url=${encodeURIComponent(canonical)}&format=json`
      );
      const info = await oembedRes.json();
      title = info.title || '';
      author = info.author_name || '';
    } catch (_) { /* metadata is optional */ }

    // Try Method 1: Direct page scrape
    let transcript = null;
    try {
      transcript = await fetchTranscriptDirect(videoId);
    } catch (err1) {
      console.warn(`[Direct] Failed: ${err1.message}`);
      // Fallback: youtube-transcript library
      try {
        transcript = await YoutubeTranscript.fetchTranscript(videoId);
      } catch (err2) {
        console.warn(`[Library] Failed: ${err2.message}`);
      }
    }

    if (transcript) {
      res.json({ success: true, transcript, title, author, videoId });
    } else {
      res.status(400).json({ success: false, error: 'Could not extract transcript. The video may not have captions available.' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: 'An unexpected server error occurred.' });
  }
});

/* ── Helpers ─────────────────────────────────────────────── */
function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?.*v=)([a-zA-Z0-9_-]{11})/,
    /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const p of patterns) {
    const m = url.trim().match(p);
    if (m) return m[1];
  }
  return null;
}

/* ── Start ───────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`\n  🎬 TranscriptGrab running at http://localhost:${PORT}\n`);
});
