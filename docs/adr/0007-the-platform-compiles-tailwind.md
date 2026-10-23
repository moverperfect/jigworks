# The React Template uses Tailwind, compiled by the platform

Agents write Tailwind by default, so a React Template without it wouldn't be a realistic test. Tailwind's own tools can't run in workerd. Its Vite plugin and CLI need Node, and its class-name scanner needs threads. Its compiler is plain JavaScript, though, so each Build runs it as a separate step:

- It uses one Tailwind version built into the platform.
- Our own scanner finds class names in the Workspace's source.
- Tailwind plugins aren't supported at first.

Tailwind's author calls this compiler API internal and undocumented, but `@react-email/tailwind` relies on it in production. If it breaks, the fallback is plain CSS files, which the Build combines along with their `@import`s.

## Consequences

- The Tailwind version comes from the platform, not from `package.json`. Templates don't list `tailwindcss`. Upgrading Tailwind is a platform change, and it reaches every Workspace at its next Build.
- Our scanner collects anything that might be a class name. Extra matches do no harm, because Tailwind skips names it doesn't know. A class name pieced together at runtime won't be found. Tailwind's own scanner has the same limit.
- `@plugin` and `@config` don't work. So plugins such as typography and forms aren't available unless we build them into the platform.
- The CSS skips the Lightning CSS pass that Tailwind's own tools run, so it isn't minified or adjusted for older browsers.
