const TS_URL = /([\d]+)id_\/(https?:.*)/;

const cfOpts = {
  scrapeShield: false,
  cacheTtlByStatus: {
    "200-299": 3600,
    "403": 0,
    "404": 1,
    "500-599": 0,
    "300-399": 10,
  },
};

// set to an array to allow only certain origins, or set to null to allow any origin to connect.
const CORS_ALLOWED_ORIGINS: string[] | null = [
  "http://localhost:10001",
  "http://localhost:8000",
  "http://localhost:3000",
  "https://proxy-test.slax.dev",
];

// ===========================================================================
async function handleRequest(request: Request): Promise<Response> {
  const url = request.url.replace(/(https?:\/)([^/])/, "$1/$2");
  const requestURL = new URL(url);
  const requestPath = requestURL.pathname;

  if (request.method === "OPTIONS") {
    return handleOptions(request);
  }

  if (requestPath.startsWith("/proxy/")) {
    const pathWithQuery = url.split(request.headers.get("host") || "", 2)[1];
    return handleLiveWebProxy(pathWithQuery.slice("/proxy/".length), request);
  }

  return notFound();
}

// ===========================================================================
async function handleLiveWebProxy(
  proxyUrl: string,
  request: Request
): Promise<Response> {
  if (proxyUrl.startsWith("//")) {
    proxyUrl = "https:" + proxyUrl;
  }

  const proxyHeaders = new Headers();
  for (const [name, value] of request.headers) {
    if (
      name.startsWith("cf-") ||
      name.startsWith("x-pywb-") ||
      name === "x-proxy-referer"
    ) {
      continue;
    }
    proxyHeaders.set(name, value);
  }

  //proxyHeaders.delete("x-forwarded-proto");
  const referrer = request.headers.get("x-proxy-referer");
  if (referrer) {
    proxyHeaders.set("Referer", request.headers.get("x-proxy-referer") || "");
    const origin = new URL(referrer).origin;
    if (origin !== new URL(proxyUrl).origin) {
      proxyHeaders.set("Origin", origin);
      proxyHeaders.set("Sec-Fetch-Site", "cross-origin");
    } else {
      proxyHeaders.delete("Origin");
      proxyHeaders.set("Sec-Fetch-Site", "same-origin");
    }
  }
  const ua = request.headers.get("x-proxy-user-agent");
  if (ua) {
    proxyHeaders.delete("x-proxy-user-agent");
    proxyHeaders.set("User-Agent", ua);
  }
  proxyHeaders.delete("host");

  const cookie = request.headers.get("x-proxy-cookie");
  if (cookie) {
    proxyHeaders.set("Cookie", cookie);
  }

  const body =
    request.method === "GET" || request.method === "HEAD" ? null : request.body;

  const resp = await fetchWithRedirCheck(
    proxyUrl,
    request.method,
    proxyHeaders,
    body
  );

  const headers = new Headers(resp.headers);

  const set_cookie = resp.headers.get("set-cookie");
  if (set_cookie) {
    headers.set("X-Proxy-Set-Cookie", set_cookie);
  }

  let status: number;
  const statusText = resp.statusText;

  if ([301, 302, 303, 307, 308].includes(resp.status)) {
    headers.set("x-redirect-status", resp.status.toString());
    headers.set("x-redirect-statusText", resp.statusText);
    if (resp.headers.get("location")) {
      headers.set("x-orig-location", resp.headers.get("location") || "");
    } else if ((resp as any).location) {
      headers.set("x-orig-location", (resp as any).location);
    }
    if ((resp as any).ts) {
      headers.set("x-orig-ts", (resp as any).ts);
    }
    status = 200;
  } else {
    status = resp.status;
  }

  addCORSHeaders(headers, request, resp);

  let respBody: ReadableStream<Uint8Array> | string;

  if (status >= 400 && !resp.headers.get("memento-datetime")) {
    respBody = `Sorry, this page was not found or could not be loaded: (Error ${status})`;
  } else {
    respBody = resp.body as ReadableStream<Uint8Array>;
  }

  return new Response(respBody, { headers, status, statusText });
}

// ===========================================================================
function addCORSHeaders(
  headers: Headers,
  request: Request,
  resp: Response
): void {
  const origin = request.headers.get("Origin");

  // no need for CORS headers!
  if (!origin) {
    return;
  }

  const allowHeaders: string[] = [
    "x-redirect-status",
    "x-redirect-statusText",
    "X-Proxy-Set-Cookie",
    "x-orig-location",
    "x-orig-ts",
  ];

  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Credentials", "true");

  for (const header of resp.headers.keys()) {
    if (["transfer-encoding", "content-encoding"].includes(header)) {
      continue;
    }

    allowHeaders.push(header);
  }

  //headers.delete("content-encoding");
  //headers.delete("transfer-encoding");

  headers.set("Access-Control-Expose-Headers", allowHeaders.join(","));
}

// ===========================================================================
function handleOptions(request: Request): Response {
  const origin = request.headers.get("Origin");
  const method = request.headers.get("Access-Control-Request-Method");
  const headers = request.headers.get("Access-Control-Request-Headers");

  if (
    CORS_ALLOWED_ORIGINS &&
    CORS_ALLOWED_ORIGINS.length &&
    origin &&
    !CORS_ALLOWED_ORIGINS.includes(origin)
  ) {
    return notFound("origin not allowed", 403);
  }

  console.log(origin, method, headers);

  // Make sure the necessary headers are present
  // for this to be a valid pre-flight request
  if (origin !== null && method !== null && headers !== null) {
    // Handle CORS pre-flight request.
    // If you want to check the requested method + headers
    // you can do that here.
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Method": method,
        "Access-Control-Allow-Headers": headers,
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Credentials": "true",
      },
    });
  } else {
    // Handle standard OPTIONS request.
    // If you want to allow other HTTP Methods, you can do that here.
    return new Response(null, {
      headers: {
        Allow: "GET, HEAD, POST, OPTIONS",
      },
    });
  }
}

// ===========================================================================
async function fetchWithRedirCheck(
  url: string,
  method: string,
  headers: Headers,
  body: ReadableStream<Uint8Array> | null
): Promise<Response> {
  let resp: Response | null = null;

  const noHttps = headers.get("X-OWT-No-HTTPS");
  if (noHttps) {
    headers.delete("X-OWT-No-HTTPS");
  }

  while (true) {
    resp = (await fetch(url, {
      method,
      headers,
      body,
      redirect: "manual",
      cf: cfOpts,
    })) as Response;

    if (resp.status > 300 && resp.status < 400 && resp.status !== 304) {
      const location = resp.headers.get("location");

      if (location) {
        const m = location.match(TS_URL);
        const m2 = url.match(TS_URL);
        if (m && m2) {
          if (m[2] === m2[2]) {
            url = location;
            continue;
          }
        }

        if (m) {
          //@ts-ignore
          resp.location = m[2];
          //@ts-ignore
          resp.ts = m[1];
        }

        if (noHttps && location.startsWith("https://")) {
          url = location;
          continue;
        }
      }
    }

    break;
  }

  return resp;
}

// ===========================================================================
function notFound(err: string = "not found", status: number = 404): Response {
  return new Response(JSON.stringify({ error: err }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export default {
  fetch: handleRequest,
};
