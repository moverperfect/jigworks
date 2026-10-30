# The Preview signs its Developer in itself

The Workspace page shows the Preview in a frame, and a frame on the platform's hostname showing a page on the apps domain is cross-site (ADR 0012). Cloudflare Access can't sign anyone in there: its login page refuses to be framed (`X-Frame-Options: DENY`). So Access lets Preview hostnames through, and the Preview's app host signs its Developer in with links that the platform makes (`docs/research/preview-sign-in.md`).

- **Getting past Access.** A second Access application, "Jigworks previews", covers `*-preview.<apps domain>` with a Bypass policy, beside "Jigworks apps" on `*.<apps domain>`. Cloudflare doesn't document which of two overlapping hostname applications wins. It was measured on 2026-10-30: `*-preview` hostnames reach the platform, and every other hostname, including `preview.` and `x-preview-y.`, still goes to Access (`docs/findings.md`).
- **The pane.** The page asks the platform, which is behind Access, for a sign-in link to the Workspace's own Preview. The app host keeps the link's token, which works once, within a minute, and only opened in a frame. It swaps the token for an `HttpOnly` session cookie named `__Host-jigworks-preview`, partitioned, because browsers keep a cross-site frame's cookies apart, and redirects so the token leaves the address bar. When the frame has no session, it asks the page for a new link.
- **A tab.** Its own link sets a first-party cookie (`SameSite=Lax`, not partitioned). A tab that arrives without a session, such as from a bookmark, goes to the platform's `/preview-sign-in`, which Access guards, and comes back with a link if the Preview is the Developer's.

## Consequences

- **The platform is the only gate on Previews.** An Access token never counts on a Preview hostname, and the gate treats a missing or unknown session as signed out.
- **No signing key.** Tokens and sessions are random values kept in the app host's own SQLite, so there's no secret to set or rotate. Ending sessions early means deleting rows.
- **App code never sees or sets the session cookie.** It's stripped from requests before they reach app code, and an app's attempt to set it is dropped with a warning. Apps still pass only `__Host-` cookies. In the pane, the platform adds `Partitioned; SameSite=None` to them, so an app's own sign-in works there as it does in a tab.
- **Only the platform's pages and the Preview's own may frame a Preview:** every Preview response carries `Content-Security-Policy: frame-ancestors 'self' <platform origin>`, beside the app's own policy.
- **Other apps can't change a Preview.** Apps on the apps domain are the same site as each other, so a `Lax` cookie goes with requests they send. The gate refuses `POST`, `PUT`, `PATCH` and `DELETE` whose `Sec-Fetch-Site` is `same-site` or `cross-site`, and a WebSocket whose `Origin` isn't the Preview's own, since its handshake is a `GET`.
- **A session lasts its 8 hours.** It isn't checked against the Developer list again, so a Developer taken off the list keeps their open Previews until then. Deleting the Workspace deletes its app host, and its sessions with it.
- **Browsers:** partitioned cookies work in Chrome and Edge 114+, Firefox 141+ and Safari 26.2+. Where they don't, the pane offers to open the Preview in a tab, which always works.
- **The precedence could change without notice.** The wizard and the live check after each deploy check both hostnames with `curl`. If "Jigworks apps" ever wins, Previews fail closed, behind Access. The fallback is a second registered domain for Previews, with no Access application on it.
- **A Deployment label never ends in `-preview`,** because its random part is 8 characters.
- **Ticket 08 said** the apps' Access application would let the Preview's Developer in. Only Deployments use it now.
