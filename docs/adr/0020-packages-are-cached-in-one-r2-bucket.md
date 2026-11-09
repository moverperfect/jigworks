# Packages are cached in one R2 bucket

One R2 bucket, the Package cache, holds npm's tarballs for every Workspace, keyed by the tarball URL's host and path (stage 7, ticket 19). It sits behind each Workspace's own copy of its Packages, which stays in the Workspace's SQLite (ADR 0004): a Check reads hundreds of Package files and a Build thousands, and SQLite is in the same process. So the cache only saves the download from npm. It's the one exception to ADR 0004: an Operator now sets up Workers, Durable Objects and this bucket.

Deployed, a cached tarball arrived in 86–138 ms, against 280–465 ms from npm, saving 0.14–0.34 s of each Package added (`docs/findings.md`, stage 7). Resolving against the registry is still the larger part of a Template's install.

## Consequences

- The cache never chooses a version. Each install still resolves against the npm registry, with the one-day minimum age, and only then takes the chosen versions' tarballs from the cache.
- Every tarball, from the cache or from npm, is checked against the registry's integrity value. A cached copy that fails is downloaded again from npm and replaced.
- An install doesn't fail because the cache does: a cache that can't be read or written costs a download from npm.
- Storage per Workspace is what it was: each keeps its own copy.
- Every Installation has the bucket, so there's one code path. A deploy creates it if it's missing, and `scripts/set-up-installation.sh` creates it before the first deploy. The deploy token needs R2 write, which the "Edit Cloudflare Workers" template has.
- Nothing is ever deleted from the cache. A tarball is a few hundred kilobytes to a few megabytes.
