/** The Access settings the platform runs with in tests (see vitest.config.ts). */
export const testAccess = {
  teamDomain: "test.cloudflareaccess.com",
  audience: "test-platform-aud",
  /** The apps' own Access application (ADR 0012). */
  appsAudience: "test-apps-aud",
  developer: "developer@example.com",
  secondDeveloper: "second@example.com",
  /** Every email at exactly this domain is on the Developer list too. */
  developerDomain: "@team.example",
  origin: "https://app.jigworks.example",
  /** The apps domain (ADR 0012). */
  appsDomain: "jigworks-apps.example",
  /** An app's origin, on the apps domain. */
  appOrigin: "https://my-app-x1y2.jigworks-apps.example",
};
