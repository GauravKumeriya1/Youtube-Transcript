/* ═══════════════════════════════════════════════════════════
   TranscriptGrab — Cloudflare Worker API
   Uses Supadata API for reliable transcript extraction.
   Deploy: npx wrangler deploy
   ═══════════════════════════════════════════════════════════ */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Route: /api/transcript?url=...
    if (url.pathname === '/api/transcript') {
      return handleTranscript(url.searchParams.get('url'), env);
    }

    return jsonResponse({ error: 'Not found' }, 404);
  }
};

async function handleTranscript(videoUrl, env) {
  if (!videoUrl) {
    return jsonResponse({ success: false, error: 'URL required' }, 400);
  }

  const videoId = extractVideoId(videoUrl);
  if (!videoId) {
    return jsonResponse({ success: false, error: 'Invalid YouTube URL.' }, 400);
  }

  const apiKey = env.SUPADATA_API_KEY;
  if (!apiKey) {
    return jsonResponse({ success: false, error: 'Server configuration error.' }, 500);
  }

  // Fetch transcript from Supadata
  try {
    const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const res = await fetch(`https://api.supadata.ai/v1/youtube/transcript?url=${encodeURIComponent(ytUrl)}&text=false&lang=en`, {
      headers: {
        'x-api-key': apiKey,
      },
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      const errMsg = errData?.message || errData?.error || '';

      if (res.status === 404 || errMsg.includes('not found') || errMsg.includes('unavailable')) {
        return jsonResponse({
          success: false,
          transcript: [],
          videoId,
          title: '',
          author: '',
          error: 'No transcript available for this video.',
        });
      }
      if (res.status === 429) {
        return jsonResponse({
          success: false,
          transcript: [],
          videoId,
          title: '',
          author: '',
          error: 'Rate limit reached. Please try again later.',
        });
      }
      throw new Error(errMsg || `Supadata returned ${res.status}`);
    }

    const data = await res.json();
    const transcript = (data.content || []).map(item => ({
      text: item.text,
      offset: item.offset || 0,
      duration: item.duration || 0,
      lang: item.lang || data.lang || 'en',
    }));

    // Fetch metadata via oEmbed
    let [title, author] = ['', ''];
    try {
      const oembedRes = await fetch(
        `https://www.youtube.com/oembed?url=${encodeURIComponent(ytUrl)}&format=json`
      );
      if (oembedRes.ok) {
        const info = await oembedRes.json();
        title = info.title || '';
        author = info.author_name || '';
      }
    } catch (_) {}

    return jsonResponse({
      success: true,
      transcript,
      videoId,
      title,
      author,
      error: null,
    });

  } catch (err) {
    return jsonResponse({
      success: false,
      transcript: [],
      videoId,
      title: '',
      author: '',
      error: err.message || 'Could not extract transcript. Please try again.',
    });
  }
}

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
  if (/^[a-zA-Z0-9_-]{11}$/.test(url.trim())) return url.trim();
  return null;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

