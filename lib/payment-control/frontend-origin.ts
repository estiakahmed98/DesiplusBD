type OriginEnvironment = Readonly<Record<string, string | undefined>>;

function configuredPublicOrigin(env: OriginEnvironment): string | null {
  // Match the application's public-URL precedence. Only operator configuration
  // can authorize an external origin; Host/Forwarded/X-Forwarded-* cannot.
  const value = [env.NEXT_PUBLIC_APP_URL, env.NEXT_PUBLIC_BASE_URL,
    env.NEXT_PUBLIC_SITE_URL, env.APP_URL, env.NEXTAUTH_URL].find(item => item?.trim());
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch { return null; }
}

export function isFrontendDiagnosticOriginAllowed(request: Request, env: OriginEnvironment = process.env): boolean {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  // Fetch Metadata is defense in depth, never a substitute for an Origin.
  if (!origin || fetchSite && fetchSite !== "same-origin") return false;
  try {
    const parsed = new URL(origin);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin) return false;
    // Next's request.url can contain its internal listener authority behind an
    // HTTPS tunnel. Compare the complete configured public origin separately.
    return origin === new URL(request.url).origin || origin === configuredPublicOrigin(env);
  } catch { return false; }
}
