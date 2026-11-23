# The app host keeps apps' alarms

An app's Durable Object instances are facets (ADR 0015), and workerd refuses alarms in a facet: "Facets currently cannot set alarms" (#107, `docs/findings.md`). Deployed, the refusal is quiet after the first call: `getAlarm()` reads the time back, and the alarm never rings. Apps that do something at a set time, such as reminding someone the day before an event, need alarms. So the app host keeps them, and app code uses Cloudflare's own API: `this.ctx.storage.setAlarm(...)`, `getAlarm()`, `deleteAlarm()` and an `alarm()` handler. This amends ADR 0015, which listed alarms as not supported.

- **The instance's own storage holds its alarm.** The module the platform wraps the app in (`src/apphost/app-data.ts`) defines `setAlarm`, `getAlarm` and `deleteAlarm` on each instance's real `ctx.storage`: the `DurableObject` base class refuses a stand-in `ctx`. The alarm is a one-row table named `__jigworks_alarm` in the instance's own database. So it commits with the call's other writes, or is lost with them, as in a `transaction()` that throws. A table, not a key, so `storage.list()` never shows it.
- **The app host's row only wakes the instance.** It keeps one row per instance: slot, binding, ID, name and the time due. Its own alarm is set for the earliest due time of those rows and of its retired Secrets (ADR 0016). A row may be early or spurious: the instance decides whether to ring.
- **The protocol:**
  - `setAlarm` first tells the app host, through `AppData`, with the instance's binding, ID and name, which reach it in `ctx.props`. Only then does it write the alarm. If the app host can't be told, `setAlarm` throws and nothing is written.
  - The app host keeps the earlier of the new time and its row's. The instance may not keep the new time: its call can still fail, as in a `transaction()` that throws. An early wake does no harm, as the instance answers with its own time. A row being rung is replaced by the new time, so an `alarm()` that sets the next isn't woken again at once. The ring's answer then brings the new row forward if the instance's own time is earlier.
  - A write whose call later fails leaves only a spurious wake, which finds no alarm and does nothing. `deleteAlarm()` doesn't tell the app host, for the same reason.
  - `setAlarm`, `getAlarm` and `deleteAlarm` run one at a time in the instance, in the order they were called, so calls made without `await` keep their order, as on Cloudflare.
  - When a row is due, the app host calls the instance's platform-named method, `__jigworks_ring`: `alarm` itself can't be called over RPC. App code can't call that method through its binding.
  - The method rings `alarm({ retryCount, isRetry })` only if the instance's own alarm is due. It clears the alarm first, so `getAlarm()` reads `null` during `alarm()` and after, unless `alarm()` sets a new one.
  - The method answers with the instance's alarm's time now, or none, and any error `alarm()` threw. A `setAlarm` still telling the app host counts, so a wake that comes before that call writes its alarm doesn't lose it. The app host replaces its row with the answer, so the row is deleted only after the instance answers. Each `setAlarm` gives the row a new version, and a ring's answer replaces only the version it rang, so a `setAlarm` during a ring isn't overwritten.
  - An instance that can't answer, such as one whose code throws as it starts, is woken again a minute later. A row whose binding has gone from the slot's code is deleted. The instance keeps its alarm, so if the binding comes back, `getAlarm()` reads a time that won't ring until the app sets one again.
  - An error goes to the slot's logs.
  - The app host sets its own alarm at most a year ahead, so an alarm too far ahead for workerd can't make it fail.
- **Data and code follow ADR 0015:** rows are per slot, an alarm rings with the slot's current code, alarms set before a new Build or a publish ring with the new code, and publishing doesn't copy alarms. Deleting the Workspace deletes the rows with the app host.
- **The Preview's alarms ring by themselves,** as the Deployment's do. The Developer sees an app's alarm work before publishing.

## Considered options

- **Cron triggers first.** They work through the app host too (#107). But "the day before each run" would mean polling, and they need a cron parser, time zones and limits of their own. The Build still fails on cron triggers.
- **The app host calling a route,** such as `POST /__scheduled`. Anyone with the app's URL could call it unless the wrapper blocked it, and it isn't how a Worker is written.
- **The app host's row alone,** as #107's probe did. A call that failed after `setAlarm` would still ring, and `deleteAll()` wouldn't cancel it, if facets had it.

## Consequences

- **At least once, as on Cloudflare.** A wake that comes before the call that set the alarm has committed, where that call then fails, rings once when it shouldn't have.
- **Every `setAlarm` makes the hops a binding's call makes** (ADR 0015), to the app host and back. `getAlarm` and `deleteAlarm` stay in the instance.
- **Not yet:** retries of a failing `alarm()` (#146), and the minimum interval, the cap per slot and rings a few at a time (#145). Until then, a failing `alarm()` is dropped, an instance that can't answer is woken every minute with no end, and rings run one at a time.
- **`AppData`'s `setAlarm` is open to app code** through `env` imported from `cloudflare:workers` (ADR 0015), for its own slot. It can add a wake, or bring one forward, and start an instance that was never used, but an instance rings only if its own alarm is due.
- **`deleteAll()` clears the alarm,** as on Cloudflare, where it works in a facet (`docs/findings.md`, #144). Locally, workerd refuses `deleteAll()` in a facet (`test/app-data.test.ts`).
- **The platform relies on facet behaviour** that a workerd upgrade could change: methods defined on `ctx.storage` are the ones the app calls, `ctx.props` reaches the instance, and the platform-named method can call `alarm()`. `test/app-data.test.ts` pins each, and the test pinning workerd's own refusal stays, so an upgrade that gives facets alarms is noticed.
