# Deployments run on Dynamic Workers inside the platform

The platform serves a Deployment the same way it serves a Preview: the Workspace's app host (ADR 0009) loads the published Build into a Dynamic Worker. Cloudflare's reference architectures for AI coding platforms do it differently, and so does vibesdk. They publish apps as real Workers, either to Workers for Platforms ($25 a month) or to the account through the Cloudflare API. We don't, for three reasons:

- The platform needs no Cloudflare API token.
- It needs no extra product.
- Previews and Deployments run the same way, so what the Developer tried out is exactly what gets hosted.

Cloudflare OS hosts its users' apps permanently on Dynamic Workers, so there is precedent.

## Consequences

- Apps can't have cron triggers or queues, and they can't be given real KV or D1 bindings. So their only storage is Durable Objects. The platform provides the binding and runs each instance as a facet inside the Workspace's app host, so app data counts towards that object's 10 GB. We don't imitate KV or D1.
- A Preview's data is kept separate from the Deployment's. A half-finished Preview can't damage data that other people rely on.
- Hosted apps depend on the platform. If the platform Worker is down or broken, every Deployment is too.
- Dynamic Workers are billed per day for each unique combination of Worker ID and code. A new Build counts as a new one, above the 1,000 a month that are included.
- Moving to Workers for Platforms later means uploading Builds through the API and swapping facets for real Durable Object namespaces. Data in the facets can't move across automatically.
