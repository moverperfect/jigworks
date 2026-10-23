# Apps live under the platform's hostname

**Replaced** by [ADR 0012](0012-apps-live-on-a-domain-of-their-own.md): apps now live on a domain of their own.

The platform lives at a hostname under the organisation's own domain, and each Preview and Deployment gets its own hostname below the platform's, such as `<name>.<platform host>`. The research recommended a separate registered domain for apps. That is the pattern github.io and googleusercontent.com use to keep their users' code away from their own sites. We chose not to, because the account the platform was first deployed on already had Advanced Certificate Manager. It covers the two-level wildcard, so no new domain had to be registered and run. The cost we accepted is that apps count as the same site as everything on the organisation's domain.

## Consequences

- App JavaScript can set cookies for the organisation's domain and for the platform's hostname. Browsers then send them to every site on that domain and to the platform. Nothing on the server can stop this. Only sandboxing the page could, and that would take cookies and `localStorage` away from apps.
- Cookies that other sites set for the whole of the organisation's domain are sent to apps too. So the platform passes only `__Host-` cookies between browsers and app code, in both directions. Browsers accept those only from the exact host that set them. Other cookies an app sets are dropped, with a warning in its logs.
- `SameSite` cookie settings don't protect the platform from apps, because apps count as the same site. Checking each request's `Origin` and `Sec-Fetch-Site` headers is the platform's only defence against requests an app sends in the Developer's name.
- The platform's hostname is a Workers Custom Domain, so deploying the platform creates its DNS record and certificate. Apps at `*.<platform host>` still need a wildcard DNS record, an Advanced Certificate Manager certificate and a Worker route on the organisation's zone (ticket 08).
- Moving apps to a separate domain later changes every app's URL.
