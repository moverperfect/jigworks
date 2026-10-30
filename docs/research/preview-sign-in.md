# Signing in to the Preview pane

Researched 2026-10-28 against developers.cloudflare.com, MDN and its browser-compat-data (BCD), the WebKit, Mozilla and Chrome blogs and release notes, the IETF cookie drafts, and Cloudflare GitHub repos. GitHub links are pinned to the commits I read:

- mdn/browser-compat-data [`09b6855`][bcd-sha] (2026-10-28) and mdn/content [`9417243`][mdn-sha] (2026-10-28).
- cloudflare/workers-sdk [`d8899ac`][wsdk-sha] (2026-10-28), for the Workers Playground's preview code.
- cloudflare/vibesdk [`32c9e42`][vibe-sha] (2026-10-22). Its preview sign-in files last changed on 2026-07-07, after the `9da158d` read for run-and-host.md.
- cloudflare/cloudflare-os [`024caa7`][cfos-sha] (2026-10-28). Nothing touching gadget hosting changed since the `8001c4b` read for run-and-host.md.
- cloudflare/terraform-provider-cloudflare [`9b51a58`][tf-sha] (2026-10-20).

"Updated" dates are the "Last updated" stamps on doc pages. "(inferred)" marks my own reading where no source says it. "Measured" marks a read-only `curl` from this machine on 2026-10-28 against Jack's Installation. Nothing was changed in Cloudflare.

This note builds on [run-and-host.md](./run-and-host.md): §4.2 (Access on app hostnames), step 10 of its recommended setup ("Embedding the Preview") and open question 4. [ADR 0012](../adr/0012-apps-live-on-a-domain-of-their-own.md) sets the hostnames. Facts already stated in those aren't repeated.

## Summary

- **Access has no documented precedence between overlapping public hostnames.** Paths have one ("the more specific rule takes precedence"), and since 2026-10-08 private destinations have one. Public hostnames don't. Partial-label wildcards such as `*-preview.<apps domain>` are documented. One application can't leave out some of its hostnames, so "this subset bypasses Access" needs a second, narrower application with a Bypass policy, and whether it wins is undocumented (§1).
- **That can be checked with two `curl`s, and it fails closed.** Access's login page names the application it matched in a `cf-access-domain` header (measured). If the Bypass application loses, Previews stay behind Access; nothing is exposed (§1, inferred).
- **Access's sign-in can't run in the pane.** Its login page sends `X-Frame-Options: DENY` and `frame-ancestors 'none'` (measured). The only iframe setting is an API field, `allow_iframe`, described in one line and nowhere in the docs (§3).
- **A partitioned `__Host-` cookie works in all four browsers today:** Chrome and Edge 114+, Firefox 141+, and Safari 26.2+. Firefox's Total Cookie Protection partitions third-party cookies anyway. Safari 18.5 to 26.1 rejects them (§2.1, §2.2).
- **A token in every URL is worse.** Root-relative links, `fetch`, forms, WebSockets, redirects and service workers all lose it unless app code cooperates, and the URL becomes a key anyone can use (§2.4).
- **Cloudflare's own Workers Playground does exactly the cookie approach.** It sets `__Host-token` with `Secure; SameSite=None; HttpOnly; Path=/; Partitioned` on a separate registrable domain, then redirects to take the token out of the URL. vibesdk does a variant (§4).
- **Recommendation:** keep the hostnames; add a Bypass application on `*-preview.<apps domain>` and check it live; sign the pane in with a signed link and a partitioned cookie; give the tab its own first-party cookie through the platform (Recommendation, below).

## Findings

### 1. Overlapping Access applications

- **Partial-label wildcards are documented.** "Using a wildcard at the beginning or end of the **Subdomain** field does not cover multiple levels." The example `*test.example.com` covers `test.example.com` and `alphatest.example.com` but not `beta.test.example.com`. A label may hold at most one wildcard ([application paths][acc-paths], updated 2026-04-17).
  - So an application on `*-preview.jigworks.app` is valid and covers `foo-preview.jigworks.app`. It covers no Deployment hostname, because those end in `-<random>` (inferred).
  - The API agrees: a public destination's `uri` "can include a domain and path with wildcards" ([create application API][acc-api-create]).
- **Precedence is documented for paths only.** "When multiple rules are set for a common root path, the more specific rule takes precedence", and a Bypass example puts a second application on `test.example.com/admin/<your-url>` ([application paths][acc-paths]; [policies][acc-policies], updated 2026-10-01). Nothing covers two hostname patterns that both match.
- **Private destinations got a rule on 2026-10-08.** "Access selects the application with the most specific matching destination. The application creation order and the order shown in the dashboard do not affect which application is selected." Between hostnames, "a hostname with more labels takes precedence. For hostnames with the same number of labels, exact labels take precedence over wildcard labels, and partial wildcards take precedence over a full `*` label" ([self-hosted private app][acc-private], updated 2026-10-12; added by [cloudflare-docs#33569][docs-33569]).
  - The section is titled "Overlapping private application destinations". It says nothing about public hostnames.
  - If public hostnames follow the same rule, `*-preview.jigworks.app` (a partial wildcard) beats `*.jigworks.app` (a full `*`) (inferred, untested).
- **Workers have a documented order, but it doesn't help.** "Hostname or path-based Access" applies before Worker-level Access, which applies before account-level. The API says the `public` and `preview_worker` destination types "take precedence" over a `worker` destination ([Workers + Access][wacc], updated 2026-10-12; [create application API][acc-api-create]).
  - So "Bypass on `*-preview` over a Worker-level Allow" would be documented. But Worker-level Access still fails WebSocket upgrades with a 403 ([Workers + Access][wacc]), so it can't guard Deployments.
- **One application can't leave hostnames out.**
  - Policies have Include, Require and Exclude rules, but their selectors are about the person or device: email, IP, country, certificate, token, group, posture and so on. None matches a hostname or path ([policies][acc-policies]).
  - Bypass "does not support identity-based rule types" and isn't logged. Access evaluates Bypass and Service Auth policies before the others ([policies][acc-policies]; [policies FAQ][acc-faq], updated 2026-10-12). Either way, a policy applies to every hostname in its application.
  - Destinations can carry `overrides` with `behavior: "public"` and a `path_pattern`: "Each rule can make a matching path public, bypassing Access authentication." These match paths, not hostnames ([create application API][acc-api-create]). A public path such as `/.jigworks/sign-in` wouldn't help either, because every later request to the host still needs `CF_Authorization` (inferred).
- **So "this subset bypasses Access" has two shapes.** Either a second application with a Bypass policy on a narrower hostname, which relies on the undocumented precedence, or patterns that don't overlap at all (inferred).
- **The Access changelog says nothing more.** Its feed up to 2026-10-28 has no entry on hostname precedence or on iframes ([Access changelog][acc-changelog]).
- **Measured: which application matched is visible.** Today `https://research-probe-preview.jigworks.app/` returns a 302 to `https://<team>.cloudflareaccess.com/cdn-cgi/access/login/research-probe-preview.jigworks.app?...`. The login page answers with `cf-access-domain: *.jigworks.app`. With a second application in place, that header, or the platform Worker answering instead, shows which one won (inferred).

### 2. Signing in inside a cross-site iframe without Access

The Workspace page is on `app.jigworks.dev` (site `jigworks.dev`). The pane frames `<slug>-<random>-preview.jigworks.app` (site `jigworks.app`). So the frame is cross-site.

#### 2.1 Partitioned cookies (CHIPS)

| Browser | `Partitioned` | `__Host-` prefix | Notes |
| --- | --- | --- | --- |
| Chrome | 114 | 49 | |
| Edge | 114 | 79 | Mirrors Chrome |
| Firefox | 141 (2025-07-22) | 50 | Shipped in 131, withdrawn in February 2025 for a login regression |
| Safari | 26.2 (2025-12-12) | 13 | Shipped in 18.4, withdrawn in 18.5 |

Versions are from [BCD `Set-Cookie`][bcd-setcookie]. Chrome's CHIPS page shows the same four numbers ([CHIPS][chips-chrome]).

- **How it works.** "A cookie's partition key is the site (scheme and registrable domain) of the top-level URL the browser was visiting at the start of the request to the endpoint that set the cookie." The browser "will only send that cookie when the top-level site is A" ([CHIPS][chips-chrome], page dated 2023-12-15). The draft spec says the same: "only include the cookie if the cookie's partition-key is same-site with the retrieval's cookie-partition-key" ([CHIPS draft §2.5][chips-draft], 2022, expired).
  - So a cookie set in the pane is keyed to `jigworks.dev`. The Preview opened in its own tab is keyed to `jigworks.app`, and doesn't see it (inferred).
- **`Partitioned` needs `Secure`.** A `Partitioned` cookie without `Secure` is ignored ([CHIPS draft §2.3, §3.1][chips-draft]; [MDN `Set-Cookie`][mdn-setcookie]).
- **`__Host-` with `Partitioned` is the recommended form.** Chrome: "It is recommended to use the `__Host-` prefix when setting partitioned cookies to make them bound to the hostname (and not the registrable domain)", with the example `Set-Cookie: __Host-example=34d8g; SameSite=None; Secure; Path=/; Partitioned;` ([CHIPS][chips-chrome]).
  - `__Host-` itself means `Secure`, `Path=/` and no `Domain` ([MDN `Set-Cookie`][mdn-setcookie]). Nothing in either rule conflicts (inferred).
  - The stricter `__Host-Http-` prefix is in Chrome 140 and Firefox 143 but not Safari ([BCD `Set-Cookie`][bcd-setcookie]).
- **The cookie must be `SameSite=None`.** For a document in a frame, the "site for cookies" is the top-level origin only if every ancestor is same-site with it. "Otherwise its 'site for cookies' is an origin set to an opaque origin" ([RFC 6265bis-22 §5.2.1][rfc6265bis], 2025-12-01). So every request from the pane, even to its own origin, is cross-site, and `Lax` or `Strict` cookies aren't sent (inferred).
  - Chrome treats a cookie with no `SameSite` as `Lax`; Firefox and Safari treat it as `None` ([MDN Storage Access API][mdn-saa], "Browser-specific variations").
  - `SameSite=None` costs little here. "A malicious top-level site will not be able to forge a request with an existing partitioned cookie unless they have compromised the top-level site that the cookie was sent from" ([CHIPS draft §3.3][chips-draft]). For the pane, that top-level site is the platform's.
- **Chrome caps partitions.** "Chrome has a limit of maximum 180 cookies per partition that cannot exceed 10 KB per-embedded-site" ([CHIPS][chips-chrome]). Every Preview host is the same embedded site, `jigworks.app`. So all Preview cookies set inside the platform share one 10 KB budget (inferred).
- **Safari's history.**
  - Safari 18.4 added CHIPS on 2025-03-31 ([Safari 18.4][webkit-184]).
  - Safari 18.5 turned it off. An Apple engineer wrote: "We unfortunately had to turn CHIPS off due to a serious bug that was too complex to address in the software update. The bug is not in WebKit." Another: "In earlier versions of Safari, any cross-site cookies were not accepted in cross-site iframes (even if they were 'Partitioned')" ([WebKit bug 292975][wk-292975]).
  - On the same bug, developers reported that 18.5 sometimes refused `Partitioned` cookies even in first-party contexts. Apple didn't confirm that.
  - Safari 26.2 brought it back: "Safari blocks setting and accessing cross-site cookies when partitioning was not requested. If siteB.example is embedded in an iframe on siteA.example and sets a partitioned cookie, that cookie is only accessible when siteB.example appears on siteA.example" ([Safari 26.2][webkit-262], 2025-12-12; [release notes][safari-262-rn]).
  - The Safari 27.0, 27.1 and 27.2 posts change nothing here. 27.0 fixed deleting partitioned cookies through `WKHTTPCookieStore` ([Safari 27.0][webkit-270], 2026-09-17; [Safari 27.1][webkit-271], 2026-10-23; [Safari 27.2][webkit-272], 2026-10-26).
- **Firefox's history.** BCD recorded `Partitioned` in Firefox 131. It was "unshipped in Firefox because of a login regression" ([BCD #25899][bcd-25899], 2025-02-11). Firefox 141 "re-enabled" CHIPS ([Firefox 141][ff-141], 2025-07-22).

#### 2.2 Default third-party cookie behaviour

- **Firefox partitions rather than blocks.** Total Cookie Protection "works by creating a separate 'cookie jar' for each website you visit", and has been the default for everyone since June 2022 ([Mozilla blog][ff-tcp], 2022-06-14). "Dynamic Partitioning: Enabled by default for all users since Firefox 103" ([MDN state partitioning][mdn-state]).
  - So in Firefox a cookie set in the pane lands in the `jigworks.dev` jar, with or without `Partitioned` (inferred).
  - Firefox also has heuristics that grant unpartitioned access after pop-ups or redirects. MDN says they "should not be relied upon" ([MDN state partitioning][mdn-state]).
  - Firefox still blocks known trackers outright ([MDN third-party cookies][mdn-3pc]). Our domains aren't trackers (inferred).
- **Safari blocks, unless the cookie asks to be partitioned.** "Cookies for cross-site resources are now blocked by default across the board" since Safari 13.1 ([WebKit][webkit-3pcb], 2020-03-24). Apple restated "We fully blocked cross-site cookies six years ago" on 2026-10-19 ([WebKit][webkit-idres]). Since 26.2, `Partitioned` cookies are the exception (§2.1).
- **Chrome allows them.** On 2025-04-22 Google decided "to maintain our current approach to offering users third-party cookie choice in Chrome", with no new prompt. Incognito "already blocks third-party cookies by default" ([Privacy Sandbox][chrome-apr25]).
  - On 2025-10-17 it retired Related Website Sets and `requestStorageAccessFor`, and kept CHIPS and FedCM ([Privacy Sandbox][chrome-oct25]). I found no later Google announcement.
  - "CHIPS, the Storage Access API, and Related Website Sets are the only way to read and write cookies from cross-site contexts, such as iframes, when third-party cookies are blocked" ([CHIPS][chips-chrome]). So a partitioned cookie also works in Incognito and for a Developer who blocks third-party cookies (inferred).
- **Edge** "blocks trackers from unvisited sites, and blocks known harmful trackers by default" ([MDN third-party cookies][mdn-3pc]). Otherwise it follows Chromium.
- **What this means for app code in the pane (inferred).** An app's own cookie without `Partitioned` behaves differently in each browser. Safari rejects it. Firefox partitions it. Chrome and Edge store it, but don't send it back if it's `Lax`, which is Chrome's default. So an app that signs its own users in works in a tab and fails in the pane unless something adds `Partitioned; SameSite=None`.

#### 2.3 The Storage Access API

- **Support.** Chrome 119, Edge 85, Firefox 65 and Safari 11.1 ([BCD `Document`][bcd-document]).
- **A gesture.** The first request needs transient activation, "such as a tap or click" ([MDN][mdn-saa], updated 2026-09-04).
- **A prior first-party visit.**
  - MDN: "Access requests are automatically denied if the browser detects that the user hasn't interacted with the embedded content in a first-party context recently (in Firefox, 'recently' means within 30 days)."
  - Safari: "Have the user interact (tap, click, or use the keyboard) with your website as first party… Navigating to and from your website in a redirect without user interaction does not count." The site must also have set a cookie as first party ([WebKit][webkit-saa], 2021-02-10).
  - Chrome: the API is "meant for use cases where… the user has visited the embedded origin in a top-level context" ([Storage Access API][saa-chrome], page dated 2023-12-15).
- **Prompts and expiry.** Safari and Chrome prompt for each new embed; Firefox prompts only after an origin asks on several sites. Grants lapse after 30 days. A grant has to be activated again in each new context, by calling `requestStorageAccess()` or with the storage access headers. Safari still grants per page ([MDN][mdn-saa]).
- **It unlocks unpartitioned cookies only** ([MDN][mdn-saa]). So it doesn't fit (inferred):
  - Behind Access, the frame's first response is Access's login page, which can't be framed (§3). No script of ours runs to call the API.
  - On a host outside Access, a partitioned cookie already works without any prompt or prior visit.

#### 2.4 The two ways in, compared

(i) is a short-lived signed link that the Preview host exchanges for a partitioned `__Host-` session cookie, then redirects to a clean URL. (ii) is a token carried in every URL, such as `?t=`.

| | (i) Signed link, then a partitioned cookie | (ii) Token in every URL |
| --- | --- | --- |
| Browsers | Chrome and Edge 114+, Firefox 141+ (and older Firefox through Total Cookie Protection), Safari 26.2+ (§2.1) | All, mechanically |
| App's own `fetch` and XHR | Sent: `credentials` defaults to `same-origin` ([MDN `RequestInit`][mdn-requestinit]) | `fetch("/api")` drops the query. When a reference has a path, `T.query = R.query` ([RFC 3986 §5.2.2][rfc3986]) |
| Form posts | Sent, because the cookie is `SameSite=None` | `action="/x"` drops it. A GET form replaces the query: "Set parsed action's query component to query" ([HTML][html-form]) |
| WebSocket upgrades | The handshake carries cookies (inferred; check by hand) | `new WebSocket("/ws")` drops it, and a page can't add headers to the handshake |
| Relative links | Fine | `/about` and `about` both drop it ([RFC 3986 §5.2.2][rfc3986]) |
| Redirects | Fine on the same host | `Location: /login` drops it |
| Service workers | Fine. In a cross-site frame they are partitioned by top-level site, from Chrome 115 ([storage partitioning][chrome-sp]) and in Firefox ([MDN state partitioning][mdn-state]) | `register("/sw.js")` fetches the script without the token |
| Own tab | Needs its own sign-in: the tab's partition key is different (§2.1) | Works, because the URL is the key |
| Leaks | The token appears only in the first request, which the redirect removes | In history, address bar and screen shares. Same-origin requests send the full URL as `Referer`, since the default policy is `strict-origin-when-cross-origin` ([MDN `Referrer-Policy`][mdn-refpol]). Anyone with the URL gets in, so "only its Developer" stops holding |

- **Rewriting doesn't rescue (ii).** vibesdk rewrites root-relative `href`, `src` and `action` in HTML, but "JS-side fetches and dynamic imports are NOT rewritten" ([run-and-host.md §4.4](./run-and-host.md#44-path-based-previews-such-as-previewid)).
- **A token in the hostname survives relative URLs.** The Sandbox SDK 0.x does this (§4). But the hostname reaches every third party in `Origin` and `Referer`. A new token would also be a new origin, so the app's `localStorage` and IndexedDB would reset with each sign-in (inferred).

### 3. Access's sign-in in an iframe

- **Measured: the login page refuses framing.** `https://<team>.cloudflareaccess.com/cdn-cgi/access/login/research-probe-preview.jigworks.app?...` returned 200 with:
  - `x-frame-options: DENY`;
  - `content-security-policy: frame-ancestors 'none'; connect-src 'self' http://127.0.0.1:*; default-src https: 'unsafe-inline'`.

  No browser renders it in a frame.
- **No documented setting.** No HTTP-application page in the Access docs mentions iframes. The only iframe note is about private applications and Chrome's local network access prompt ([self-hosted private app][acc-private]).
  - The API has `allow_iframe` on self-hosted applications and on `PUT /access/apps/{app_id}/settings`: "Enables loading application content in an iFrame." That one line is all there is, in the API reference and in Terraform's docs ([create application API][acc-api-create]; [settings API][acc-api-settings]; [Terraform][tf-access]).
  - It says "application content", not the login page. I didn't test it, because that means changing the Installation's application.
- **Chrome and Edge might get through without the page (inferred, untested).**
  - The team domain's `CF_Authorization` is `SameSite=None` ([authorization cookie][acc-cookie], updated 2026-08-03), and Chrome sends third-party cookies by default. With a live global session, Access may redirect straight back without rendering the login page.
  - But the app host's `CF_AppSession` came back with no `SameSite` attribute (measured), although the docs list it as `None`. Chrome treats that as `Lax`, so it isn't sent inside the frame. Whether the callback needs it is undocumented.
  - It would still fail in Incognito.
- **Safari and Firefox can't get through.** The team domain's cookie isn't sent into the frame: Safari blocks it, and Firefox looks in the empty `jigworks.dev` jar (§2.2). So Access serves the login page, which can't be framed (inferred).
- This settles run-and-host.md open question 4: Access can't sign the pane in across the four browsers.

### 4. Prior art

- **Workers Playground** ([`playground-preview-worker/src/index.ts`][pg-index]). This is Cloudflare's own embedded preview, and it is approach (i).
  - Previews live on a separate registrable domain, `cloudflarepreviews.com`, through a route `*.cloudflarepreviews.com/*` ([wrangler.json L27-L38][pg-wrangler]). The editor builds `https://${v4()}.${PREVIEW}/.update-preview-token?token=…`, a fresh random host for each preview ([useDraftWorker.ts L124-L128][pg-draft]).
  - The exchange "must be called with a random subdomain to provide cookie isolation for the preview." It throws unless `Sec-Fetch-Dest` is `iframe` and the `Referer` host is the playground ([L222-L254][pg-check]). That check was added to fix "VULN-49261", which "allowed Workers Playground preview instances to be accessed from outside of playground contexts" ([workers-sdk#4634][pg-4634], 2023-12-20).
  - It then sets the cookie and redirects ([L266-L274][pg-set]):

    ```ts
    setCookie(c, PREVIEW_COOKIE_NAME, token, {
    	secure: true,
    	sameSite: "None",
    	httpOnly: true,
    	path: "/",
    	partitioned: true,
    });
    return c.redirect(url.searchParams.get("suffix") ?? "/", 307);
    ```

    `PREVIEW_COOKIE_NAME` is `"__Host-token"` ([L18][pg-name]). `partitioned: true` arrived "to address the upcoming deprecation of third party cookies in Chrome" ([workers-sdk#5004][pg-5004], 2024-02-13).
  - It deletes `X-Frame-Options` from the preview's responses, because "This will be embedded in an iframe" ([L318-L321][pg-xfo]).
- **The dashboard's Quick Editor** ([`edge-preview-authenticated-proxy/src/index.ts`][epap]) does the same.
  - The token goes into KV under a random ID, with the hostname. The comment says "A preview token should only be valid for an hour", and the KV entry lasts two. The browser gets the ID as `__Host-token` with `Secure; SameSite=None; HttpOnly; Path=/; Partitioned`, and a 307 ([L336-L390][epap-update]).
  - Later requests are refused if `tokenRecord.hostname !== url.hostname` ([L200-L213][epap-check]).
- **vibesdk** ([`spacePreviewToken.ts`][v-token], [`space-preview.ts`][v-handler]):
  - A 30-minute HS256 JWT arrives as `?t=`. The handler strips `?t=` before forwarding, so "the generated app never sees the token" ([L48-L51][v-strip]). It serves the page in place, without a redirect, and sets the cookie on that response ([L151-L168][v-handler]).
  - The cookie is `__space_preview`, `HttpOnly`, path-scoped to `/space/<name>/preview/<branch>`. On a separate preview domain it adds `SameSite=None; Secure; Partitioned` ([L58-L87][v-cookie]). Path scoping rules out `__Host-`.
  - Tokens are revoked by bumping `previewVersion` ([L84-L97][v-version]).
  - In June 2026, after Safari 26.2, it added a banner: "Preview may not fully load in Safari due to preview being served from a different domain", with an "Open in new tab" button. It shows for every WebKit browser when the preview is cross-site ([preview-compat-banner.tsx L21-L64][v-banner]; commit [`cf88d69`][v-banner-commit]). The commit doesn't say which Safari versions failed.
- **Sandbox SDK.**
  - 0.x puts the token in the hostname, `https://{port}-{sandbox-id}-{token}.yourdomain.com`: "Preview URLs are publicly accessible by default, but require a valid access token" ([preview URLs][sbx-urls], updated 2026-10-23).
  - The newer guide shares a preview as `/shared/<NAME>/<TOKEN>/`: "The shared route needs no authentication, because the token is the permission" ([previews][sbx-previews], updated 2026-10-22).
  - Its own-hostname guide uses a separate preview domain, a wildcard record and a route, much as ADR 0012 does. It says: "Authenticate preview visitors on the preview hostname, and do not send your application session cookie there" ([own hostnames][sbx-hosts], updated 2026-10-12).
- **Workers Previews and Pages previews** use Access, opened as a top-level page ([Workers Previews custom domains][wp-domains], updated 2026-09-24; [Pages preview deployments][pages-preview], updated 2026-10-12). Neither documents embedding. I found no Workers for Platforms page on signing in to an embedded preview.
- **Cloudflare OS** still gives gadgets no URLs. Their UI runs in a sandboxed `srcdoc` frame and reaches the server over `postMessage` ([run-and-host.md §4.5](./run-and-host.md#45-how-vibesdk-and-cloudflare-os-do-it)).

## What I couldn't confirm

1. **Which application wins** when `*-preview.<apps domain>` (Bypass) and `*.<apps domain>` (Allow) both match. It's undocumented. The live check in the Recommendation settles today's behaviour, not the rule.
2. **What `allow_iframe` does.** One line in the API, untested.
3. **Whether partitioned cookies ride WebSocket handshakes and service-worker fetches** in each browser. That's inferred from how cookies and partitioning work, not from a source that says it.
4. **Why vibesdk still warns Safari users.** A current Safari bug, an older Safari, or its path-scoped cookie: the commit doesn't say.
5. **Whether the Access redirect completes silently in a Chrome frame.** It doesn't matter for the recommendation, which doesn't rely on it.
6. **Any 2026 change to Chrome's third-party cookies.** The newest Google source I found is from 2025-10-17.

## Sources

Cloudflare:

- [Application paths][acc-paths], updated 2026-04-17.
- [Access policies][acc-policies], updated 2026-10-01, and the [policies FAQ][acc-faq], updated 2026-10-12.
- [Self-hosted private application][acc-private], updated 2026-10-12, with [cloudflare-docs#33569][docs-33569], merged 2026-10-08.
- [Add an Access application (API)][acc-api-create] and [Update Access application settings (API)][acc-api-settings], read 2026-10-28.
- [Authorization cookie][acc-cookie], updated 2026-08-03.
- [Workers + Access][wacc], updated 2026-10-12.
- [Access changelog feed][acc-changelog], read 2026-10-28.
- [Terraform `zero_trust_access_application`][tf-access], commit `9b51a58` (2026-10-20).
- [Workers Previews: custom domains][wp-domains], updated 2026-09-24, and [Pages preview deployments][pages-preview], updated 2026-10-12.
- [Sandbox preview URLs][sbx-urls], updated 2026-10-23; [Preview a web application][sbx-previews], updated 2026-10-22; [Serve previews on their own hostnames][sbx-hosts], updated 2026-10-12.
- Workers Playground: [`playground-preview-worker`][pg-index], [`edge-preview-authenticated-proxy`][epap], [workers-sdk#4634][pg-4634] (2023-12-20), [workers-sdk#5004][pg-5004] (2024-02-13).
- vibesdk: [`spacePreviewToken.ts`][v-token], [`space-preview.ts`][v-handler], [`preview-compat-banner.tsx`][v-banner], commit [`cf88d69`][v-banner-commit] (2026-06-18).

Browsers and specs:

- [BCD `Set-Cookie`][bcd-setcookie] and [BCD `Document`][bcd-document], commit `09b6855` (2026-10-28); [BCD #25899][bcd-25899] (2025-02-11).
- [MDN `Set-Cookie`][mdn-setcookie], [Storage Access API][mdn-saa] (2026-09-04), [Third-party cookies][mdn-3pc] (2026-06-15), [State partitioning][mdn-state], [`Referrer-Policy`][mdn-refpol], [`RequestInit`][mdn-requestinit], at mdn/content `9417243` (2026-10-28).
- Chrome: [CHIPS][chips-chrome] and [Storage Access API][saa-chrome] (both dated 2023-12-15), [Storage partitioning][chrome-sp] (2025-06-13), [Next steps for Privacy Sandbox][chrome-apr25] (2025-04-22), [Update on plans for Privacy Sandbox technologies][chrome-oct25] (2025-10-17).
- WebKit and Apple: [Safari 18.4][webkit-184] (2025-03-31), [Safari 26.2][webkit-262] (2025-12-12), [Safari 26.2 release notes][safari-262-rn], [Safari 27.0][webkit-270] (2026-09-17), [Safari 27.1][webkit-271] (2026-10-23), [Safari 27.2][webkit-272] (2026-10-26), [WebKit bug 292975][wk-292975] (2025-05-14, closed 2026-04-30), [Full third-party cookie blocking][webkit-3pcb] (2020-03-24), [Updates to the Storage Access API][webkit-saa] (2021-02-10), [Blocking identity resolution infrastructure][webkit-idres] (2026-10-19).
- Mozilla: [Firefox 141 release notes][ff-141] (2025-07-22), [Total Cookie Protection by default][ff-tcp] (2022-06-14, updated 2024-08-28).
- Specs: [RFC 6265bis-22 §5.2.1][rfc6265bis] (2025-12-01), [CHIPS draft-01][chips-draft] (2022-11-10, expired), [RFC 3986 §5.2.2][rfc3986], [HTML form submission][html-form].

## Recommendation

### Preview hostnames and Access

1. **Keep the hostname scheme.** Previews stay at `<slug>-<random>-preview.<apps domain>`. Add a second self-hosted application, "Jigworks previews", with public hostname subdomain `*-preview` on the apps domain and one policy: Bypass, Include Everyone. Keep "Jigworks apps" on `*` with its Allow policy. Ticket 17's wizard gains this step at stage 7.
2. **Check the precedence live before the ADR is written,** and put the result in `docs/findings.md`:
   - `curl -sI https://anything-preview.<apps domain>/` should come from the platform Worker, with no `Location` on `cloudflareaccess.com`.
   - `curl -sI https://anything.<apps domain>/` should still redirect to Access, and the login page should say `cf-access-domain: *.<apps domain>`.
   - Add the same pair to the wizard's checks and to the live check after each deploy, because the behaviour is undocumented and could change.
3. **Either outcome is safe** (inferred).
   - If Allow wins, Previews fail closed. The pane shows Access's unframeable login page, and the tab still works through Access.
   - If Bypass wins, the platform is the only gate on Preview hosts. So the gate treats them as signed out until its own link or cookie checks out, and never accepts `Cf-Access-Jwt-Assertion` or `CF_Authorization` there.
   - That matters because the apps' `CF_Authorization` isn't `HttpOnly` unless the Operator turns it on (`docs/findings.md`, "A second Installation"), so any Deployment's script can read it. The wizard should turn `HttpOnly` on for "Jigworks apps" too, as it does for the platform.
4. **Keep Deployment hostnames out of `*-preview`.** A Deployment's hostname ends in `-preview` only if its random part is the word `preview`. A random part of fixed length other than 7 rules that out.
5. **If the check shows Allow winning,** move Previews to a second registrable domain, a "previews domain", at `<slug>-<random>.<previews domain>`, with its own wildcard DNS record and Worker route and no Access application.
   - Every piece of that is documented, and nothing overlaps.
   - It costs a second registration. It also makes Previews cross-site to Deployments (inferred).
   - If a second domain is unwanted, make the patterns disjoint instead: end every Deployment's random part in a digit, and give "Jigworks apps" ten hostnames, `*0` to `*9`, instead of `*` (documented partial wildcards; inferred and untested).

### Keeping the pane signed in

Use approach (i), as Cloudflare's playground does.

1. **Mint a link for every load.** The pane asks the platform for a link with a same-origin `POST`, which the platform's Access already guards. The platform checks that the Developer owns the Workspace.
   - The link is `https://<preview host>/__jigworks/sign-in?t=<token>&to=<path>`.
   - The token is signed by the platform and holds the Workspace, the Developer, the host, `dest: "iframe"`, a 60-second expiry and a revocation counter, like vibesdk's `previewVersion`.
   - The pane mints a fresh link whenever it loads the frame, including the reload after each new Build. So the cookie is renewed all the time (inferred).
2. **The exchange.** The gate checks the token, the host, the expiry and `Sec-Fetch-Dest: iframe` (Chrome 80, Firefox 90, Safari 16.4: [BCD][bcd-secfetch]), as the playground does. It answers `303 See Other` to `<path>`, with `Cache-Control: no-store` and:

   ```http
   Set-Cookie: __Host-jigworks-preview=<session>; Path=/; Secure; HttpOnly; SameSite=None; Partitioned; Max-Age=<no more than the platform's Access session>
   ```

   The redirect takes the token out of the frame's URL.
3. **Reserve the cookie's name.** Ticket 08's filter passes every `__Host-` cookie, so the gate must also strip this one before app code runs, and drop any app `Set-Cookie` with the same name. Keep its value small: in Chrome, every Preview opened inside the platform shares one 10 KB budget (§2.1).
4. **Make app cookies work in the pane** (inferred). On requests that carry a pane session, the gate adds `Partitioned; SameSite=None; Secure` to each `__Host-` cookie the app sets. An app's own sign-in then behaves the same in all four browsers, instead of failing differently in each (§2.2).
5. **Limit who can frame it** (inferred). Add `Content-Security-Policy: frame-ancestors <platform origin>` to Preview responses as a header of its own. Browsers enforce every CSP header they receive, so the app's own policy still applies. This stops any other page on the platform's site, or any app on the apps domain, from framing a signed-in Preview.
6. **Recover in the pane.** When the cookie is missing or expired, the gate answers a framed navigation with a small page that `postMessage`s the platform's origin. The pane then mints a new link.
   - If the cookie still doesn't stick, the pane says so and offers "Open in a new tab". That covers Safari before 26.2 and Developers who block all cookies.
   - To tell "no cookie yet" from "cookies refused", the exchange can add a one-off marker to the redirect, which the gate strips (inferred).

### Opening the Preview in its own tab

The pane's cookie doesn't follow the Preview into a tab, because the tab's partition key is the apps domain (§2.1).

1. **The open-in-tab button mints its own link,** with `dest: "document"`, and opens it with `window.open(url, "_blank", "noopener")`. The exchange sets a first-party cookie with no `Partitioned`:

   ```http
   Set-Cookie: __Host-jigworks-preview=<session>; Path=/; Secure; HttpOnly; SameSite=Lax
   ```

   Leaving out `Partitioned` also avoids the first-party failures reported for Safari 18.5 (§2.1).
2. **A tab that arrives without a cookie goes through the platform.** That covers a bookmark, a link in the Conversation, a reload after expiry, and a `target="_blank"` link inside the app.
   - The gate redirects top-level navigations to `https://<platform>/preview-sign-in?host=<preview host>&to=<path>`. That page sits behind the platform's Access application.
   - The platform redirects back with a fresh `dest: "document"` link.
   - Every step is a top-level, first-party navigation, so it works in all four browsers (inferred).
   - Accept only the Developer's own Preview hosts for `host`, and only a path for `to`, so it can't be an open redirect.
3. **Sibling apps are still same-site** with the tab's cookie (ADR 0012). The gate can refuse non-`GET` requests whose `Sec-Fetch-Site` is `same-site` or `cross-site` (inferred).

### For the ADR and the manual check

- **The ADR records:**
  - the Bypass application, and that its precedence was measured, not documented, with the fallback in step 5;
  - that the pane keeps its sign-in in a partitioned `__Host-` cookie and not in URLs;
  - that the tab gets its own first-party cookie through the platform.
- **The manual check** in Chrome, Firefox and Safari 26.2 or later, with Edge if it's to hand, covers:
  - the pane loading;
  - an app `fetch`, a form `POST` and a WebSocket;
  - an app that sets its own `__Host-` cookie;
  - the open-in-tab button;
  - a visit to the Preview hostname with no cookie;
  - the pane after its cookie expires.

[bcd-sha]: https://github.com/mdn/browser-compat-data/tree/09b6855aa1362f1550c6ca34f8b074c3d4390d4d
[mdn-sha]: https://github.com/mdn/content/tree/94172439968170ab04c730b4f93a699688f7f367
[wsdk-sha]: https://github.com/cloudflare/workers-sdk/tree/d8899ac4c85ff839d73daa9055a76a36248cd2e3
[vibe-sha]: https://github.com/cloudflare/vibesdk/tree/32c9e429cd2712ea5959a89f65ae434162b89229
[cfos-sha]: https://github.com/cloudflare/cloudflare-os/tree/024caa73b98c91eb3267f5af092ec5abbda9e842
[tf-sha]: https://github.com/cloudflare/terraform-provider-cloudflare/tree/9b51a582458f5c5d46d8547ed2604fcba91fb861
[acc-paths]: https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/
[acc-policies]: https://developers.cloudflare.com/cloudflare-one/access-controls/policies/
[acc-faq]: https://developers.cloudflare.com/cloudflare-one/faq/policies-faq/
[acc-private]: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/non-http/self-hosted-private-app/#overlapping-private-application-destinations
[docs-33569]: https://github.com/cloudflare/cloudflare-docs/pull/33569
[acc-api-create]: https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/methods/create/
[acc-api-settings]: https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/subresources/settings/methods/update/
[acc-cookie]: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/
[acc-changelog]: https://developers.cloudflare.com/changelog/rss/access.xml
[wacc]: https://developers.cloudflare.com/workers/configuration/cloudflare-access/
[tf-access]: https://github.com/cloudflare/terraform-provider-cloudflare/blob/9b51a582458f5c5d46d8547ed2604fcba91fb861/docs/resources/zero_trust_access_application.md
[wp-domains]: https://developers.cloudflare.com/workers/previews/custom-domains/
[pages-preview]: https://developers.cloudflare.com/pages/configuration/preview-deployments/
[sbx-urls]: https://developers.cloudflare.com/sandbox/sdk/concepts/preview-urls/
[sbx-previews]: https://developers.cloudflare.com/sandbox/previews/
[sbx-hosts]: https://developers.cloudflare.com/sandbox/previews/serve-previews-on-their-own-hostnames/
[pg-index]: https://github.com/cloudflare/workers-sdk/blob/d8899ac4c85ff839d73daa9055a76a36248cd2e3/packages/playground-preview-worker/src/index.ts
[pg-name]: https://github.com/cloudflare/workers-sdk/blob/d8899ac4c85ff839d73daa9055a76a36248cd2e3/packages/playground-preview-worker/src/index.ts#L18
[pg-check]: https://github.com/cloudflare/workers-sdk/blob/d8899ac4c85ff839d73daa9055a76a36248cd2e3/packages/playground-preview-worker/src/index.ts#L222-L254
[pg-set]: https://github.com/cloudflare/workers-sdk/blob/d8899ac4c85ff839d73daa9055a76a36248cd2e3/packages/playground-preview-worker/src/index.ts#L266-L274
[pg-xfo]: https://github.com/cloudflare/workers-sdk/blob/d8899ac4c85ff839d73daa9055a76a36248cd2e3/packages/playground-preview-worker/src/index.ts#L318-L321
[pg-wrangler]: https://github.com/cloudflare/workers-sdk/blob/d8899ac4c85ff839d73daa9055a76a36248cd2e3/packages/playground-preview-worker/wrangler.json#L27-L38
[pg-draft]: https://github.com/cloudflare/workers-sdk/blob/d8899ac4c85ff839d73daa9055a76a36248cd2e3/packages/workers-playground/src/QuickEditor/useDraftWorker.ts#L124-L128
[pg-4634]: https://github.com/cloudflare/workers-sdk/pull/4634
[pg-5004]: https://github.com/cloudflare/workers-sdk/pull/5004
[epap]: https://github.com/cloudflare/workers-sdk/blob/d8899ac4c85ff839d73daa9055a76a36248cd2e3/packages/edge-preview-authenticated-proxy/src/index.ts
[epap-update]: https://github.com/cloudflare/workers-sdk/blob/d8899ac4c85ff839d73daa9055a76a36248cd2e3/packages/edge-preview-authenticated-proxy/src/index.ts#L336-L390
[epap-check]: https://github.com/cloudflare/workers-sdk/blob/d8899ac4c85ff839d73daa9055a76a36248cd2e3/packages/edge-preview-authenticated-proxy/src/index.ts#L200-L213
[v-token]: https://github.com/cloudflare/vibesdk/blob/32c9e429cd2712ea5959a89f65ae434162b89229/worker/utils/spacePreviewToken.ts
[v-cookie]: https://github.com/cloudflare/vibesdk/blob/32c9e429cd2712ea5959a89f65ae434162b89229/worker/utils/spacePreviewToken.ts#L58-L87
[v-handler]: https://github.com/cloudflare/vibesdk/blob/32c9e429cd2712ea5959a89f65ae434162b89229/worker/api/handlers/space-preview.ts#L124-L175
[v-strip]: https://github.com/cloudflare/vibesdk/blob/32c9e429cd2712ea5959a89f65ae434162b89229/worker/api/handlers/space-preview.ts#L48-L51
[v-version]: https://github.com/cloudflare/vibesdk/blob/32c9e429cd2712ea5959a89f65ae434162b89229/worker/api/handlers/space-preview.ts#L84-L97
[v-banner]: https://github.com/cloudflare/vibesdk/blob/32c9e429cd2712ea5959a89f65ae434162b89229/src/routes/chat/components/preview-compat-banner.tsx#L21-L64
[v-banner-commit]: https://github.com/cloudflare/vibesdk/commit/cf88d691c5451b8e191c898154ae4758e13058d8
[bcd-setcookie]: https://github.com/mdn/browser-compat-data/blob/09b6855aa1362f1550c6ca34f8b074c3d4390d4d/http/headers/Set-Cookie.json
[bcd-document]: https://github.com/mdn/browser-compat-data/blob/09b6855aa1362f1550c6ca34f8b074c3d4390d4d/api/Document.json
[bcd-secfetch]: https://github.com/mdn/browser-compat-data/blob/09b6855aa1362f1550c6ca34f8b074c3d4390d4d/http/headers/Sec-Fetch-Dest.json
[bcd-25899]: https://github.com/mdn/browser-compat-data/pull/25899
[mdn-setcookie]: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie
[mdn-saa]: https://developer.mozilla.org/en-US/docs/Web/API/Storage_Access_API
[mdn-3pc]: https://developer.mozilla.org/en-US/docs/Web/Privacy/Guides/Third-party_cookies
[mdn-state]: https://developer.mozilla.org/en-US/docs/Web/Privacy/Guides/State_Partitioning
[mdn-refpol]: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Referrer-Policy
[mdn-requestinit]: https://developer.mozilla.org/en-US/docs/Web/API/RequestInit#credentials
[chips-chrome]: https://privacysandbox.google.com/cookies/chips
[saa-chrome]: https://privacysandbox.google.com/cookies/storage-access-api
[chrome-sp]: https://privacysandbox.google.com/cookies/storage-partitioning
[chrome-apr25]: https://privacysandbox.google.com/blog/privacy-sandbox-next-steps
[chrome-oct25]: https://privacysandbox.google.com/blog/update-on-plans-for-privacy-sandbox-technologies
[webkit-184]: https://webkit.org/blog/16574/webkit-features-in-safari-18-4/
[webkit-262]: https://webkit.org/blog/17640/webkit-features-for-safari-26-2/
[safari-262-rn]: https://developer.apple.com/documentation/safari-release-notes/safari-26_2-release-notes#Privacy
[webkit-270]: https://webkit.org/blog/18325/webkit-features-for-safari-27-0/
[webkit-271]: https://webkit.org/blog/18486/webkit-features-for-safari-27-1/
[webkit-272]: https://webkit.org/blog/18515/webkit-features-for-safari-27-2/
[wk-292975]: https://bugs.webkit.org/show_bug.cgi?id=292975
[webkit-3pcb]: https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/
[webkit-saa]: https://webkit.org/blog/11545/updates-to-the-storage-access-api/
[webkit-idres]: https://webkit.org/blog/18438/blocking-identity-resolution-infrastructure/
[ff-141]: https://www.mozilla.org/en-US/firefox/141.0/releasenotes/
[ff-tcp]: https://blog.mozilla.org/en/mozilla/firefox-rolls-out-total-cookie-protection-by-default-to-all-users-worldwide/
[rfc6265bis]: https://www.ietf.org/archive/id/draft-ietf-httpbis-rfc6265bis-22.html#section-5.2.1
[chips-draft]: https://www.ietf.org/archive/id/draft-cutler-httpbis-partitioned-cookies-01.html
[rfc3986]: https://www.rfc-editor.org/rfc/rfc3986#section-5.2.2
[html-form]: https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#submit-mutate-action
