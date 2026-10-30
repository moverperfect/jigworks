# Apps live on a domain of their own

ADR 0008 put each Preview and Deployment under the platform's own hostname, because the account the platform was first deployed on already had Advanced Certificate Manager for the two-level wildcard. Jigworks is now installed by organisations on their own accounts, and most won't have that. Agent-written apps under the platform's hostname would also be the same site as the platform and as the rest of the organisation's domain. So Jigworks takes the research's recommendation instead (`docs/research/run-and-host.md`, "Recommended setup", step 8): an Installation's apps live on their own registered domain, the apps domain, which the Operator sets in its configuration. That's the pattern github.io and googleusercontent.com use. Jack's Installation has its platform at `app.jigworks.dev` and its apps on `jigworks.app`.

## Consequences

- The apps domain must be a registered domain with its own zone on the Installation's account. A subdomain of another domain would be the same site as its parent, and would need Advanced Certificate Manager for its wildcard.
- Apps are cross-site to the organisation's other sites. App JavaScript can't set cookies those sites receive, and their domain-wide cookies never reach apps.
- Apps are cross-site to the platform. But Access sets its cookie with `SameSite=None` unless the Operator chooses otherwise, so `SameSite` protects the platform only once its Access application uses Lax. Ticket 17's wizard sets Lax. Either way, the platform keeps checking `Origin` and `Sec-Fetch-Site` on every API call and WebSocket upgrade, because those checks don't depend on the Operator's settings.
- Every app is still the same site as every other app on the apps domain. One app's JavaScript can set a cookie for the whole apps domain, and browsers then send it to every other app. So the platform still passes only `__Host-` cookies between browsers and app code, in both directions. It drops any other cookie an app sets, with a warning in the app's logs.
- Universal SSL's free certificate covers the apps domain and `*.<apps domain>`, so no Advanced Certificate Manager is needed. The apps domain needs a proxied wildcard DNS record, and a Worker route `*.<apps domain>/*` to the platform Worker (ticket 08).
- A wildcard certificate covers one level, so app hostnames use the first label only: `<slug>-<random>.<apps domain>` for a Deployment, and `<slug>-<random>-preview.<apps domain>` for its Preview.
- The apps domain has its own Access application, and the platform checks that application's AUD apart from its own. Both sign in through the same team domain, so nobody signs in twice.
- The Preview pane on the Workspace page is now a cross-site frame:
  - Browsers that block or partition third-party cookies, such as Safari and Firefox, won't send the apps' Access cookie into it (inferred). So ticket 08's short-lived signed link is likely to be the pane's normal way in, not a fallback.
  - A signed link only works on a hostname that Access doesn't intercept. How Access resolves an application for `*-preview.<apps domain>` inside one for `*.<apps domain>` is undocumented (`docs/research/run-and-host.md`, open question 4).
  - [ADR 0013](0013-the-preview-signs-its-developer-in-itself.md) settles both: a Bypass application lets Preview hostnames through, and the pane keeps its sign-in in a partitioned cookie.
- Each Operator registers and runs a second domain, which costs a domain registration.
- The Public Suffix List would make apps cross-site to each other too. Its maintainers turn down small projects, so applying waits for the hosted SaaS (ticket 22).
- Moving an Installation's apps to another domain later changes every app's URL.
