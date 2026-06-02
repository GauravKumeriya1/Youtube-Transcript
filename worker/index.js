/* ═══════════════════════════════════════════════════════════
   TranscriptGrab — Cloudflare Worker Router
   Forwards requests to the Vercel backend (which uses proxies).
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
      const targetUrl = url.searchParams.get('url');
      if (!targetUrl) {
        return jsonResponse({ success: false, error: 'URL required' }, 400);
      }

      try {
        // Forward the fetch request to the Vercel API (which is proxy-enabled)
        const vercelRes = await fetch(
          `https://youtube-transcript-ochre-three.vercel.app/api/transcript?url=${encodeURIComponent(targetUrl)}`
        );
        const data = await vercelRes.json();
        return jsonResponse(data, vercelRes.status);
      } catch (err) {
        return jsonResponse({
          success: false,
          transcript: [],
          videoId: '',
          title: '',
          author: '',
          error: `Forwarding failed: ${err.message}`
        }, 500);
      }
    }

    return jsonResponse({ error: 'Not found' }, 404);
  }
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}
