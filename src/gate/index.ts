import { verifyAccess, type AccessConfig } from "../access";

export interface GateConfig extends AccessConfig {
  /**
   * The Developer list: comma-separated emails, and `@domain` entries that let
   * in every email at exactly that domain. While it's empty, nobody gets in.
   */
  developerList: string | undefined;
  /** The platform's origin, such as `https://app.example.com`. */
  origin: string | undefined;
  /**
   * For `wrangler dev` only: the email to treat a localhost request as
   * signed in with. Ignored for any other hostname.
   */
  devSignedInAs?: string | undefined;
  /**
   * For a page the browser opens from elsewhere, such as the Preview's way
   * back to sign in: only GET, and from any site, since all it can do is
   * send the signed-in Developer on to their own Preview.
   */
  navigation?: boolean;
}

/** The signed-in Developer's email, or the response that refuses the request. */
export type GateDecision = { ok: true; email: string } | { ok: false; response: Response };

const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Decides whether a request may reach the platform. It must carry a valid
 * token from the platform's Access application for an email on the Developer
 * list, and must come from the platform's own pages. Apps live on a domain of
 * their own (ADR 0012), but the Access cookie's `SameSite` setting is the
 * Operator's choice. So the `Origin` and `Sec-Fetch-Site` headers are what stop
 * an app's page sending requests in a Developer's name.
 */
export async function gate(request: Request, config: GateConfig): Promise<GateDecision> {
  if (config.navigation) {
    if (request.method !== "GET") return refuse(405, "Only GET is allowed here.");
  } else {
    const origin = request.headers.get("Origin");
    const site = request.headers.get("Sec-Fetch-Site");
    const mustHaveOrigin =
      !safeMethods.has(request.method) || request.headers.get("Upgrade")?.toLowerCase() === "websocket";
    if ((origin !== null || mustHaveOrigin) && origin !== config.origin) return refuseElsewhere();
    // Browsers say where every request comes from. "none" is the Developer
    // opening a URL themselves.
    if (site !== null && site !== "same-origin" && site !== "none") return refuseElsewhere();
  }

  const url = new URL(request.url);
  let email: string;
  if (config.devSignedInAs && localHosts.has(url.hostname)) {
    email = config.devSignedInAs;
  } else {
    const identity = await verifyAccess(request, config);
    if (!identity) return refuse(401, "Sign in through Cloudflare Access.");
    if (identity.kind !== "person") return refuse(403, "Only a Developer can use the platform.");
    email = identity.email;
  }

  const address = email.toLowerCase();
  if (!isOnDeveloperList(address, config.developerList)) return refuse(403, `${email} isn't a Developer on this platform.`);
  return { ok: true, email: address };
}

/** `@domain` matches that domain only, never its subdomains. */
function isOnDeveloperList(address: string, list: string | undefined): boolean {
  return (list ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .some((entry) => entry === address || (entry.startsWith("@") && address.endsWith(entry)));
}

function refuseElsewhere(): GateDecision {
  return refuse(403, "This request didn't come from the platform's own pages.");
}

function refuse(status: number, error: string): GateDecision {
  return { ok: false, response: Response.json({ error }, { status }) };
}
