# Apps run in a second Durable Object per Workspace

Every request to a Preview or a Deployment passes through the Durable Object that runs it, and a Durable Object does one thing at a time. If that were the Workspace's own object (ADR 0003), a Check or a Build using a few seconds of CPU would freeze the Deployment for everyone using it. App data would also share the Workspace's memory and storage. So each Workspace has a second Durable Object, its app host. The app host holds:

- the Workspace's Builds
- the Preview and the Deployment
- their data and their logs

The Workspace's own object keeps the files, the packages and the Conversation, and it sends each new Build to the app host.

## Consequences

- Every Build is copied from one object to the other.
- The Agent's Preview tools and the Developer's Preview logs reach across to the app host.
- App data has its own 10 GB and doesn't count towards the Workspace's.
- Deleting a Workspace means deleting both objects.
