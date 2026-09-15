import { createServer, request, type OutgoingHttpHeaders } from 'node:http';

/** Operator-run filter. Never tunnel the daemon's local-control listener. */
export function createPublicIngress(daemonPort: number) {
  return createServer(
    { requestTimeout: 10_000, headersTimeout: 10_000 },
    (req, res) => {
      // Compare the raw target, before any URL decoding or normalization. Neither
      // loopback peers nor Host/forwarded headers confer access to local routes.
      const oauthCallback =
        req.method === 'GET' &&
        (req.url === '/api/linear/oauth/callback' ||
          req.url?.startsWith('/api/linear/oauth/callback?'));
      const review =
        req.method === 'GET' &&
        !req.url?.includes('..') &&
        (/^\/reviews\/[0-9a-f]{64}(?:\/report\.json|\/images\/s_[0-9a-f]{32})?$/.test(
          req.url ?? '',
        ) ||
          /^\/review-assets\/assets\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,199}\.(?:js|css|woff2)$/.test(
            req.url ?? '',
          ));
      if (!(
        (req.method === 'GET' && req.url === '/api/ping') ||
        (req.method === 'POST' && req.url === '/api/linear/webhook') ||
        oauthCallback ||
        review
      )) {
        res.writeHead(404, { connection: 'close' }).end();
        return;
      }

      const headers: OutgoingHttpHeaders = {};
      if (req.method === 'POST') {
        for (const name of ['content-type', 'linear-signature']) {
          if (req.headers[name] !== undefined)
            headers[name] = req.headers[name];
        }
      }
      // Only POST's signed bytes and their two protocol headers cross the boundary.
      // Node supplies fresh HTTP framing; no hop-by-hop/override headers survive.
      const upstream = request(
        {
          hostname: '127.0.0.1',
          port: daemonPort,
          method: req.method,
          path: req.url,
          headers,
          signal: AbortSignal.timeout(10_000),
        },
        (reply) => {
          const publicHeaders: OutgoingHttpHeaders = {};
          if (review)
            for (const name of [
              'content-security-policy',
              'referrer-policy',
              'x-content-type-options',
              'x-robots-tag',
            ]) {
              if (reply.headers[name] !== undefined)
                publicHeaders[name] = reply.headers[name];
            }
          res.writeHead(reply.statusCode ?? 502, {
            ...publicHeaders,
            'content-type': reply.headers['content-type'] ?? 'application/json',
            'cache-control': 'no-store',
          });
          reply.on('error', () => res.destroy());
          reply.pipe(res);
        },
      );
      upstream.on('error', () => {
        if (res.headersSent) res.destroy();
        else res.writeHead(502).end();
      });
      res.on('close', () => upstream.destroy());
      if (req.method === 'GET') {
        // A framed GET body must never become an unframed second daemon request.
        req.resume();
        upstream.end();
      } else {
        req.pipe(upstream);
      }
    },
  );
}
