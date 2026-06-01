import http from 'http';
import url from 'url';
import { YoutubeTranscript } from 'youtube-transcript';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { ProxyAgent } from 'undici';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3001;

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
];

/* ── Direct page-scrape transcript fetcher ─────────────── */
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

  const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, fetchOptions);

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

  const captionOptions = {
    headers: { 'User-Agent': ua }
  };
  if (agent) {
    captionOptions.dispatcher = agent;
  }

  const captionRes = await fetch(track.baseUrl + '&fmt=json3', captionOptions);
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
}

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

  // 3. Try from Supabase if credentials are provided in env
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
  if (supabaseUrl && supabaseKey) {
    try {
      const { createClient } = await import('@supabase/supabase-js');
      const supabase = createClient(supabaseUrl, supabaseKey);
      const { data } = await supabase
        .from('youtube_proxies')
        .select('proxy_url')
        .eq('is_active', true);
      if (data) {
        proxies.push(...data.map(d => d.proxy_url));
      }
    } catch (err) {
      console.warn('[Proxy Loader] Error loading from Supabase:', err.message);
    }
  }

  // Deduplicate
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

/* ── Transcript API ─────────────────────────────────────── */
const server = http.createServer(async (req, res) => {
  // Set CORS and content type headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  const parsedUrl = url.parse(req.url, true);

  if (parsedUrl.pathname === '/api/transcript' && req.method === 'GET') {
    try {
      const urlParam = parsedUrl.query.url;
      if (!urlParam) {
        res.writeHead(400);
        return res.end(JSON.stringify({ success: false, error: 'YouTube URL is required' }));
      }

      const videoId = extractVideoId(urlParam);
      if (!videoId) {
        res.writeHead(400);
        return res.end(JSON.stringify({ success: false, error: 'Invalid YouTube URL' }));
      }

      // Load active proxies and shuffle
      const proxies = await getProxies();
      const shuffledProxies = [...proxies].sort(() => Math.random() - 0.5);

      // Fetch video metadata via oEmbed (with proxy retries and fallback to no-proxy)
      let title = '', author = '';
      const tryFetchMetadata = async (agent) => {
        const canonical = `https://www.youtube.com/watch?v=${videoId}`;
        const fetchOptions = {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
          }
        };
        if (agent) {
          fetchOptions.dispatcher = agent;
        }
        const oembedRes = await fetch(
          `https://www.youtube.com/oembed?url=${encodeURIComponent(canonical)}&format=json`,
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
          const proxyStr = shuffledProxies[i];
          const proxyIp = proxyStr.split(':')[0];
          console.log(`[Metadata] Attempt ${i + 1}/${maxMetadataProxyAttempts} using proxy: ${proxyIp}`);
          const agent = createProxyAgent(proxyStr);
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
          console.log(`[Metadata] Trying WITHOUT proxy`);
          metadata = await tryFetchMetadata(undefined);
        } catch (err) {
          console.warn(`[Metadata WITHOUT proxy failed]: ${err.message}`);
        }
      }

      if (metadata) {
        title = metadata.title || '';
        author = metadata.author_name || '';
      }

      // Fetch transcript content
      let transcript = null;
      const errors = {};

      // Try Method 1: Direct page scrape with proxy retries
      const maxDirectProxyAttempts = Math.min(3, shuffledProxies.length);
      for (let i = 0; i < maxDirectProxyAttempts; i++) {
        const proxyStr = shuffledProxies[i];
        const proxyIp = proxyStr.split(':')[0];
        try {
          console.log(`[Direct] Attempt ${i + 1}/${maxDirectProxyAttempts} using proxy: ${proxyIp}`);
          const agent = createProxyAgent(proxyStr);
          if (agent) {
            transcript = await fetchTranscriptDirect(videoId, agent);
            if (transcript && transcript.length > 0) break;
          }
        } catch (err) {
          console.warn(`[Direct Proxy Attempt failed]: ${err.message}`);
          errors[`proxy_${proxyIp}`] = err.message;
        }
      }

      // If no success with proxies, try direct page scrape WITHOUT proxy
      if (!transcript) {
        try {
          console.log(`[Direct] Trying WITHOUT proxy`);
          transcript = await fetchTranscriptDirect(videoId, undefined);
        } catch (err1) {
          console.warn(`[Direct] Failed WITHOUT proxy: ${err1.message}`);
          errors['direct_no_proxy'] = err1.message;

          // Fallback: youtube-transcript library (always WITHOUT proxy)
          try {
            console.log(`[Library] Trying youtube-transcript`);
            transcript = await YoutubeTranscript.fetchTranscript(videoId);
          } catch (err2) {
            console.warn(`[Library] Failed: ${err2.message}`);
            errors['library'] = err2.message;
          }
        }
      }

      if (transcript) {
        const segments = transcript.map(t => ({
          start: Number((t.offset / 1000).toFixed(2)),
          end: Number(((t.offset + t.duration) / 1000).toFixed(2)),
          text: t.text
        }));

        const lastSeg = segments[segments.length - 1];
        const duration = lastSeg ? Math.ceil(lastSeg.end) : 0;
        const lang = transcript[0]?.lang || 'en';

        res.writeHead(200);
        res.end(JSON.stringify({
          video: {
            platform: 'youtube',
            id: videoId,
            title: title || 'Unknown Title',
            author: author || 'Unknown Author',
            thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
          },
          duration: duration,
          transcripts: {
            [lang]: {
              segments: segments
            }
          }
        }));
      } else {
        res.writeHead(400);
        res.end(JSON.stringify({ 
          success: false, 
          error: 'Could not extract transcript. The video may not have captions available.',
          details: errors
        }));
      }
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ success: false, error: 'An unexpected server error occurred.' }));
    }
  } else {
    // Handle 404 for other routes
    res.writeHead(404);
    res.end(JSON.stringify({ success: false, error: 'Not Found' }));
  }
});

/* ── Helpers ─────────────────────────────────────────────── */
function extractVideoId(urlStr) {
  const patterns = [
    /(?:youtube\.com\/watch\?.*v=)([a-zA-Z0-9_-]{11})/,
    /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const p of patterns) {
    const m = urlStr.trim().match(p);
    if (m) return m[1];
  }
  return null;
}

/* ── Start ───────────────────────────────────────────────── */
if (!process.env.VERCEL) {
  server.listen(PORT, () => {
    console.log(`\n  🎬 TranscriptGrab running (Node.js native) at http://localhost:${PORT}\n`);
  });
}

export default server;
