# 10: Publish a Deployment

**Parent:** [spec](../spec.md), user stories 16 and 54 to 57 (stage 5)

**What to build:** The Developer presses Publish, and the current Build becomes the Workspace's Deployment at its own hostname. Anyone the apps' Access application lets in can open it, by signing in with their organisation's account. It stays the same until the Developer publishes again.

**Blocked by:** 08 (Preview the latest Build).

**Status:** ready-for-agent

- [ ] Publish stores a copy of the current Build as the Deployment. Later Builds don't change it.
- [ ] The Deployment is at `<slug>-<random>.<apps domain>`. Anyone the apps' Access application lets in can open it.
- [ ] Deployments get the same protections as the Preview:
  - Access headers stripped;
  - only `__Host-` cookies passed;
  - the same runtime limits.
- [ ] Each Workspace has one Deployment, and there is no rollback.
- [ ] Deleting a Workspace takes its Deployment down and deletes the app host along with the Workspace.

## Tasks

1. Publish button, storing a copy of the Build.
2. Deployment hostname, open to anyone the apps' Access application lets in.
3. Deleting a Workspace takes its Deployment down.

Drafted by an AI agent on Jack's behalf.
