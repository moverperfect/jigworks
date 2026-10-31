# Design directions for the chat-first journey

Three visual directions for one decided structure. Each is built by a different designer, in parallel, from this file alone: read **Shared constraints**, then your direction's section. The sections stand alone; don't read the other two for guidance (do read them if you want to make sure yours looks nothing like them).

| Variant | Direction | File | CSS prefix |
| --- | --- | --- | --- |
| E | Direction 1, "On the bench" | `VariantE.tsx` + `VariantE.css` | `ve-` |
| F | Direction 2, "Fridge door" | `VariantF.tsx` + `VariantF.css` | `vf-` |
| G | Direction 3, "Stage directions" | `VariantG.tsx` + `VariantG.css` | `vg-` |

## Shared constraints

### What this is

Jigworks lets someone build and host a small web app by talking to an AI Agent. It's being redesigned for regular people, not developers: a running-club organiser, someone lending a lawnmower to neighbours, an office kitchen rota. Chat is the primary flow. The Agent picks the starting Template itself. Nothing technical on show; the code stays behind one escape hatch.

The first round of prototypes (`VariantA.tsx`, `VariantB.tsx`) looked generic: system fonts, grey rounded cards, an indigo accent, pill chips. Don't repeat any of that.

### The structure (decided, don't change it)

1. **Brand new app: a start page.** Centred. Asks "What would you like to make?", has a big composer, a few example ideas (`ideas` from `simulation.ts`), and the person's existing apps (hard-code two: "Bake sale orders", live, changed yesterday; "Allotment rota", not published, changed 3 weeks ago).
2. **After the first message, and for every existing app: the working layout.** The Conversation in a left pane; the live app on the large right canvas; a header carrying the app's name, its publish status and the Publish button. While the first build runs, the canvas shows building progress. During later Turns the app stays visible with an "Updating…" state. The canvas has Phone and Computer views, and the Code escape hatch (render the shared `CodePeek`). On a phone, Chat and App tabs; switch to App when a Build lands (`state.version` goes up), as Variant B does.
3. **Every state has to work:** first build, a later Turn, the Agent asking a question with answer buttons, a failed Turn, and published, including published with changes not yet published.

Within that, your direction is free on identity, type, colour, density, and how the chat, the progress, the hand-off from start page to split, and the publish moment look and feel.

### Build constraints

- React, one component file and one plain CSS file per variant, every class carrying the variant's prefix. The placeholder files already exist and are wired into `ChatFirstPrototypePage.tsx`; keep the exported name (`VariantE` and so on) and the `{ sim }` prop.
- No new npm dependencies. Web fonts come from Google Fonts by CSS `@import` at the top of your CSS file; each direction gives the exact import line, verified to resolve.
- Light and dark mode via `@media (prefers-color-scheme: dark)` (the platform's `styles.css` already does this and sets `color-scheme: light dark`). Define your direction's tokens as custom properties on the variant's root element, with dark values in the media query. The app being built (`FakeApp`) keeps its own light look in both modes; that's intended, it's someone else's app.
- Visible keyboard focus (`:focus-visible`) on every control, in the direction's colours.
- Respect `prefers-reduced-motion: reduce`: each direction lists its motion and what replaces it.
- Works at 390 px wide; the switcher bar (`.proto-bar`) sits under the stage, so your root fills `.proto-stage` with `height: 100%`.
- British English, sentence case, plain words. The product's name stays Jigworks.

### Words

Use these words in the UI, consistently, and nothing more technical:

- The thing being made is **your app**; the saved list is **Your apps**. Not Workspace, project, site.
- The AI is **the Agent** (the glossary's word). Where a direction names the speaker, it's "Agent"; the person is "You".
- The Template is a **starting point**. The simulation already phrases the step as "Choosing a starting point" with the result "A web page that remembers things". The Template's real name ("Worker + React") only appears inside **Technical details**, the collapsed list of `step.detail` lines.
- Publishing: **Publish**, **Publish changes**, **Not published**, **Live**, **Live, with changes not yet published**. Don't join status fragments with middle dots; write a phrase.
- Before publishing, the canvas says **Only you can see this until you publish**. After, it shows the link, `appUrl`.
- The escape hatch is **See the code**, small and at the end of the canvas toolbar.
- The composer's start placeholder is a real example, not "Describe your app…". Enter sends; Shift+Enter adds a line.
- The publish confirmation's copy, so the three are compared on the same words (its presentation is yours):
  - Not yet published: "Publish Sunday Runs?" / "Anyone with the link will be able to use it: sunday-runs.jigworks.app" / "You can keep changing it here. People see your changes only when you publish again." / buttons "Not yet", "Publish".
  - Live with changes: "Publish your changes?" / "People using the link have the earlier version. Publishing gives them this one." / "Not yet", "Publish changes".
  - Live and up to date: "Sunday Runs is live" / the link / "Copy the link", "Done".

### The simulation (`simulation.ts`), what to read

One scripted Agent drives every variant; use `sim.state` and these calls. Don't change `simulation.ts`.

| Need | Read |
| --- | --- |
| Which layout | `state.phase === "start"` shows the start page; anything else the split. |
| App name | `state.appName` (null until the Agent names it). |
| Chat | `state.messages`: `from: "you"` (text, optional `pointedAt`) or `from: "agent"` (text with `\n\n` paragraphs, `steps[]`, optional `choices[]`, `failed`, `builtVersion`). |
| Steps | `step.label` (plain words), `step.result` (what it decided), `step.status`: `running`, `done`, `fixing`, `failed`; `step.detail` is the technical line. |
| Working | `state.phase === "working"`; `state.activity` is the current step in words; `state.progress` is `{ done, total }`; `state.turnStartedAt`. |
| First build vs later Turn | `state.app === null` means nothing built yet, so a working phase is the first build; with an app, it's an update. |
| Question | `state.pendingQuestion !== null`; the latest Agent message has `choices`. Answer with `sim.send(choice)`. |
| Failure | Latest Agent message `failed === true`; the app hasn't changed. `state.suggestions` then holds "Try a different way" and so on. |
| Suggestions | `state.suggestions` after a Turn; `sim.send(text)`. |
| Publish | `state.published` (`{ version, at }` or null); `hasUnpublishedChanges(state)`; `sim.publish()`; `state.version`. |
| Starting point | `state.plan?.startingPoint` has `plain`, `template`, `why`. |
| Start | `sim.start(text)` from the start page; `sim.send(text)` afterwards. |

The floating bar can jump to six moments: Start, Working (paused mid first build, two steps done), Ready, Question, Problem, Published (live version 1, with version 2 unpublished). Check every one of them, on desktop and at 390 px, in light and dark.

---

## Direction 1: "On the bench"

Jigworks is named after the jig: the frame on a workbench that holds a piece steady while it's worked on. This direction takes that literally and nothing else. The Agent is the jig; your app is the piece held in it; publishing releases it. Everything is sturdy, cool and square, like a well-kept workshop, not a software product.

### Tokens

**Colour** (light; dark in the right column)

| Name | Light | Dark | Role |
| --- | --- | --- | --- |
| Mat | `#C9DBCF` | `#1B3129` | The canvas background: a cutting mat. The app sits on it. |
| Paper | `#FAFAF7` | `#1F2A25` | The chat pane, the header, dialogs, the building panel. |
| Graphite | `#2A2D2B` | `#E6EAE7` | All text. A pencil, not black. |
| Marking blue | `#2546A8` | `#8FA8FF` | The one action colour: Publish, Send, Make it, links, focus, the brackets while working, "Live". Machinists' layout fluid. |
| Chalk | `#C7462E` | `#F08A72` | Failure only: the failed step, the brackets after a failed Turn. A chalk line. |

Muted text is Graphite at 62% opacity; rules and borders are Graphite at 18% opacity. No other colours, no gradients, no shadows anywhere except a 1 px Graphite-at-18% edge on the app's sheet.

**Type**: one family, Archivo, with its width axis doing the work of a second family.

```css
@import url("https://fonts.googleapis.com/css2?family=Archivo:ital,wdth,wght@0,62..125,100..900;1,62..125,100..900&display=swap");
```

| Role | Setting |
| --- | --- |
| The question on the start page | 44 px, weight 700, `font-stretch: 118%`, line-height 1.05, letter-spacing −0.01em |
| Wordmark "Jigworks" and app name | 18 px, weight 700, stretch 118% |
| Chat text, dialog text | 16 px, weight 400, stretch 100%, line-height 1.5, max 62ch |
| Steps, status, bracket labels, toolbar | 14 px, weight 500, `font-stretch: 86%` (semi-condensed), line-height 1.35 |
| Buttons | 15 px, weight 600, stretch 100% |
| Your apps list | 16 px names at stretch 100%; status and dates at 14 px stretch 86% |

The condensed width marks "the Agent's working notes" (steps, status, labels) against the normal width of conversation. That contrast is the typographic system; don't add bold-caps labels on top of it.

**Shape and space**: corners 2 px everywhere (a bench, not a phone). An 8 px grid; chat pane padding 20 px; canvas padding 32 px. The chat pane is 22 rem wide on desktop. The left pane is left-aligned; the start page is a centred 40 rem column with left-aligned text inside it; the canvas centres the app.

**Principles**

1. The brackets are the only expressive element. Everything else is flat Paper on Mat with pencil-grey text.
2. Width, not colour or boxes, says what kind of text something is.
3. Nothing floats: no shadows, no blur, no gradients. Things sit on surfaces.
4. The app's state is told by the brackets' posture (closed, tight, open, red) and by one label at the top-left bracket, so a glance at the canvas answers "what's happening to my app?"

### The one memorable thing: the jig brackets

Four L-shaped corner brackets, 3 px thick, 28 px long on each arm, drawn in Graphite, framing whatever is on the canvas. They have four postures:

- **Holding** (app ready, not published): brackets sit 16 px outside the app's corners. Label at the top-left bracket: "Only you can see this until you publish".
- **Working** (a Turn is running): brackets turn Marking blue and close in 8 px tighter. Label: "Updating: adding a waiting list…" (`state.activity`). The app stays visible and usable at 85% opacity.
- **Released** (published and up to date): brackets open to 40 px outside the corners and fade to 35% opacity. The piece is out of the jig. Label: "Live at sunday-runs.jigworks.app", with a "Copy the link" text button beside it.
- **Held again** (published, with changes not yet published): back to the holding posture, Graphite, label "Changes not yet published. People with the link have the earlier version."
- **Failed** (last Turn failed): holding posture but Chalk, label "That didn't work. Your app hasn't changed."

The brackets also appear on the start page, around the composer: the jig is waiting for your idea. On send, the hand-off is the brackets travelling from the composer to the canvas (one 450 ms ease-in-out move; under reduced motion they simply appear at the canvas) while the page becomes the split and your sentence becomes the first message.

Implementation hint: a positioned wrapper `.ve-jig` around the canvas content, with four absolutely-positioned `span`s (`aria-hidden`), each with two borders; posture classes change `inset`, `border-color` and `opacity`, with a 300 ms transition that `prefers-reduced-motion` turns off.

### Wireframes

Start page (desktop):

```
┌──────────────────────────────────────────────────────────────────────┐
│ Jigworks                                                             │ Paper header, 1px rule
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │ Mat
│            What would you like to make?                              │ 44px wide Archivo
│            Say it in your own words. The Agent builds it, and        │ 16px, ≤62ch
│            you can change anything by asking.                        │
│                                                                      │
│           ⌜                                                ⌝         │ brackets, Graphite
│            ┌────────────────────────────────────────────┐            │ Paper sheet, 2px corners
│            │ A sign-up sheet for my running club…       │            │ 3 rows, 18px text
│            │                                   [Make it]│            │ Marking blue button
│            └────────────────────────────────────────────┘            │
│           ⌞                                                ⌟         │
│                                                                      │
│            Or start from one of these                                │ 14px semi-condensed
│            A sign-up sheet for my running club's Sunday runs         │ text buttons, Marking
│            A page where neighbours can borrow my lawnmower           │ blue, underlined on
│            A rota for who's cleaning the office kitchen              │ hover/focus
│                                                                      │
│            Your apps                                                 │ 18px wide
│            ───────────────────────────────────────────────           │ Graphite 18% rule
│            Bake sale orders          Live        changed yesterday   │
│            Allotment rota      Not published  changed 3 weeks ago    │
└──────────────────────────────────────────────────────────────────────┘
```

Split layout (desktop), app ready and not published:

```
┌──────────────────────────────────────────────────────────────────────┐
│ Jigworks  Sunday Runs   Not published                     [Publish]  │ Paper, 1px rule
├────────────────────────┬─────────────────────────────────────────────┤
│ You                    │ Phone  Computer   Open in a new tab  See the code
│ A sign-up sheet for my │                                             │ Mat
│ running club's Sunday  │  ⌜ Only you can see this until you publish  │ label at the
│ runs                   │                                          ⌝  │ top-left bracket
│                        │    ┌───────────────────────────────────┐    │
│ Agent                  │    │                                   │    │ the app on a
│ Lovely idea. I'll make │    │         Sunday Runs (live)        │    │ Paper sheet with
│ a page where runners…  │    │                                   │    │ a 1px edge
│                        │    │                                   │    │
│ ✓ Choosing a starting  │    │                                   │    │
│   point  A web page    │    │                                   │    │
│   that remembers things│    └───────────────────────────────────┘    │
│ ✓ Naming your app      │  ⌞                                       ⌟  │
│   Sunday Runs          │                                             │
│ ✓ Designing the…       │                                             │
│ ✓ Keeping track of…    │                                             │
│ ✓ Making sure it works │                                             │
│   All good             │                                             │
│ Technical details      │                                             │
│                        │                                             │
│ Your app's ready…      │                                             │
├────────────────────────┤                                             │
│ Add a waiting list     │                                             │ suggestions: text
│ Make it look sportier  │                                             │ buttons, Marking blue
│ Email me when someone… │                                             │
│ ┌────────────────────┐ │                                             │
│ │ Ask for a change…  │ │                                             │
│ │             [Send] │ │                                             │
│ └────────────────────┘ │                                             │
└────────────────────────┴─────────────────────────────────────────────┘
```

The chat pane is Paper; the canvas is Mat; the 1 px rule between them is Graphite 18%. Messages have no bubbles: a speaker line ("You" or "Agent") in 14 px semi-condensed muted, then the text. Your messages are set 24 px in from the left so the two voices read as two columns of indentation, not two colours. Steps are a checklist in the semi-condensed width with a ✓, ◌ (running, Marking blue), ↻ (fixing) or ✕ (failed, Chalk) glyph; the result sits on the next line, muted.

Phone (390 px):

```
┌───────────────────────────┐
│ Jigworks        [Publish] │
│ Sunday Runs               │ 2-line header; status
│ Not published             │ under the name
├───── Chat ─────┬── App ───┤ two tabs, active one
│                │          │ with a 3px Graphite
│ You            │          │ underline
│ A sign-up…     │          │
│ Agent          │          │
│ Lovely idea…   │          │
│ ✓ Choosing…    │          │
│                │          │
├────────────────┴──────────┤
│ Add a waiting list        │
│ ┌───────────────────────┐ │
│ │ Ask for a change…     │ │
│ └───────────────────────┘ │
└───────────────────────────┘
App tab: the brackets frame the whole canvas at 12px inset; the label becomes
a one-line strip above the app; Phone/Computer and "See the code" sit in that strip.
```

### How each state looks

**First build.** The canvas shows the brackets at the size the app will be (a 36 rem by full-height sheet area), Marking blue, working posture. Inside, on a Paper panel: the current activity as the title in 24 px wide Archivo ("Designing the sign-up page"), under it a 3 px Marking-blue progress rule that fills by `progress.done / progress.total`, then the done steps as a semi-condensed list: "Starting point: A web page that remembers things", "Name: Sunday Runs", "Designed the sign-up page". When the Build lands, the panel is replaced by the app's sheet and the brackets go Graphite and settle to the holding posture (a 300 ms transition; none under reduced motion). The chat shows the same steps ticking in the Agent's message; the composer is disabled with the placeholder "The Agent is working…".

**Later Turn.** The app stays on the canvas at 85% opacity; brackets go Marking blue and tight; label "Updating: adding a waiting list…". In the chat the new Agent message types in with its steps. When it finishes, the app re-renders in place and the brackets relax to holding.

**Question.** No change on the canvas. In the chat, the Agent's question is followed by its answers as two outlined Marking-blue buttons (2 px corners, 15 px weight 600) side by side; the composer's placeholder becomes "Or type an answer…".

**Failure.** The Agent's message shows the "Making sure it works" step with ✕ in Chalk and "Couldn't fix it"; the outro explains in plain words (the simulation's text); the brackets turn Chalk in holding posture with the label "That didn't work. Your app hasn't changed." Suggestions "Try a different way" and "Leave it for now" appear as usual. Nothing shakes, nothing turns red beyond the brackets, the step glyph and its label.

**Published.** Pressing Publish opens a Paper panel anchored under the button (a popover, 2 px corners, 1 px edge, no shadow) with the shared copy. On confirming, the brackets open to the released posture and the label changes to "Live at sunday-runs.jigworks.app" with "Copy the link". The header status reads "Live" in Marking blue; the button reads "Share". After a later Turn changes the app, the brackets close again (held again posture), the status reads "Live, with changes not yet published", and the button reads "Publish changes".

**Phone and Computer.** A two-segment control in semi-condensed type with a 2 px Graphite outline; the active segment is filled Graphite with Paper text. Phone view narrows the sheet to 24 rem; the brackets follow it.

**See the code.** Opens `CodePeek` on the Paper sheet inside the brackets, in the holding posture, label "The code". Closing restores the app.

### Motion and reduced motion

Three movements only: the brackets travelling from composer to canvas on the first send (450 ms); bracket posture changes (300 ms); the progress rule's width (200 ms). Under `prefers-reduced-motion: reduce` all three are instant. There is no typing cursor, no pulsing, no shimmer; the working state is told by colour and the label.

### Review against the brief and the skill's defaults

- The first draft put a faint grid on the Mat, like a real cutting mat. Removed: a grid under an app reads as a design tool, which is exactly the "technical on show" the brief forbids. The Mat colour alone carries the bench.
- The first draft had a sixth colour, brass (`#A8863A`), for "Live", on the idea of a brass fitting. Removed: a gold "live" state is a stock SaaS flourish and would be the only warm colour in a cool palette. "Live" is now Marking blue and the released bracket posture, which says the same thing without a new colour.
- Steps were going to carry a small elapsed-time counter from `turnStartedAt`. Removed as the one accessory too many: the progress rule already tells how far along it is.
- Checked against the skill's list: no cream (`Paper` is a neutral `#FAFAF7`, not `#F4F1EA`), no terracotta, no near-black-plus-neon (dark mode is deep green and slate-green), no hairline broadsheet columns, no card kit (one sheet with one edge, no shadows), no caps eyebrows, no middle-dot meta strings (statuses are phrases), no `#111` posing as black (`Graphite` is a chosen grey-green), no monospace labels, no arrows on buttons.
- Checked against the typographic tells: one family with the width axis as the hierarchy, no single accented word in the headline, no caps labels, no eyebrow above the composer.
- Checked against the words rule: the only technical term in view is behind "Technical details".

---

## Direction 2: "Fridge door"

The apps people make here are the things that used to be a sheet stuck on the fridge, the noticeboard or the office kitchen wall: who's coming, who's got the mower, whose turn it is. So the interface is that surface. What you say is a yellow note you've stuck up; the Agent answers in ink straight onto the door; your app is a sheet of paper pinned on the right. Bright, big, quick, and with real affection for the people it's for.

### Tokens

**Colour** (light; dark in the right column)

| Name | Light | Dark | Role |
| --- | --- | --- | --- |
| Door | `#F4F4F1` | `#1B2341` | The background everywhere: the fridge door. Light, it's white enamel; dark, it's a deep ink-blue door. |
| Sheet | `#FFFFFF` | `#FFFFFF` | The paper the app is on, and dialogs. Stays white in dark mode: paper on a dark door. |
| Note | `#FFE66D` | `#FFE66D` | Your messages, the composer, the Publish button in dark mode. A canary sticky note; the same in both modes, it's an object. |
| Ink | `#1D2A4D` | `#E9ECF5` (text) | All text and the Publish button in light mode. On a Note it stays `#1D2A4D` in both modes. |
| Marker green | `#157A52` | `#5CD39A` | "Live", the tick on done steps. A whiteboard marker. |
| Marker red | `#C8392B` | `#FF8A7A` | Failure only. |

Muted text is Ink at 60% opacity. Rules are Ink at 15%. The one shadow in the design is under a Note: `0 1px 2px rgba(29, 42, 77, 0.18)`, the paper lifting off the door. Nothing else casts one.

**Type**: one family, Atkinson Hyperlegible Next, designed for legibility by people with low vision; a product for everyone deserves a face made for everyone. It has enough character at heavy weights for display.

```css
@import url("https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible+Next:ital,wght@0,200..800;1,200..800&display=swap");
```

(If the browser can't fetch it, the fallback stack is `"Atkinson Hyperlegible", system-ui, sans-serif`.)

| Role | Setting |
| --- | --- |
| The question on the start page, written on the big note | 40 px, weight 800, line-height 1.1, Ink |
| Wordmark "Jigworks" | 20 px, weight 800 |
| App name in the header | 20 px, weight 600 |
| Text on notes (your messages, the composer) | 18 px, weight 500, line-height 1.4 |
| The Agent's ink (replies) | 17 px, weight 400, line-height 1.55, max 58ch |
| Steps, status, toolbar | 15 px, weight 500 |
| Buttons | 16 px, weight 700 |
| Small print (dates, "changed yesterday") | 14 px, weight 400, muted |

**Shape and space**: notes are rectangles with 2 px corners and a 2° rotation (alternating −1.5° and +1.5° down the conversation); buttons are 10 px-cornered; the app's Sheet has square corners. Generous: 12 px grid, chat padding 24 px, 48 px minimum touch targets. The chat pane is 25 rem on desktop. The start page is centred; notes are left-aligned inside; the Agent's ink is left-aligned.

**Principles**

1. Who's speaking is told by material: you write on notes, the Agent writes in ink on the door. No bubbles, no avatars, no names.
2. Big and few. Fewer controls than you'd think, each large enough to hit with a thumb.
3. Colour is for objects and marker pens, not for decoration: yellow is a note, green is a tick, red is a cross.
4. Warm without being childish: the type is plain and well set, the rotations are tiny, nothing bounces.

### The one memorable thing: your words are notes

The composer *is* a blank note. On the start page it's a big square note in the middle of the door with "What would you like to make?" written at its top in heavy Ink, a textarea beneath, and a "Make it" button at its bottom right. In the split layout it's a smaller note at the bottom of the chat pane. Sending it sticks it to the conversation: the note you typed into becomes the message (same yellow, same shadow), a fresh blank one appears below. The Agent's replies have no container: Ink on Door, with a 3 px left margin stroke in Ink 15% to mark their extent.

The hand-off from start page to split is that first note: it lifts (translate up 8 px, 150 ms), the door slides it left into the chat column while the canvas opens on the right (350 ms). Under reduced motion the layout simply changes with the note in its new place.

Suggestions after a Turn are small blank-looking notes with the suggestion written on, overlapping slightly at angles below the Agent's reply ("Add a waiting list when it's full"). Tapping one sticks it in as your message. The Agent's question offers its answers the same way: two small notes to pick from.

### Wireframes

Start page (desktop):

```
┌──────────────────────────────────────────────────────────────────────┐
│ Jigworks                                                             │ Door, no rule
│                                                                      │
│                   ┌──────────────────────────────┐                   │ one big Note,
│                   │ What would you like           │                   │ 28rem wide,
│                   │ to make?                      │                   │ rotated −1.5°
│                   │                               │                   │
│                   │ A sign-up sheet for my        │                   │ textarea, 18px
│                   │ running club…                 │                   │
│                   │                               │                   │
│                   │                     [Make it] │                   │ Ink button
│                   └──────────────────────────────┘                   │
│                                                                      │
│              ┌───────────┐ ┌───────────┐ ┌───────────┐               │ three small Notes,
│              │A sign-up  │ │A page     │ │A rota for │               │ 10rem, ±2°, Ink text
│              │sheet for… │ │where…     │ │who's…     │               │ 15px
│              └───────────┘ └───────────┘ └───────────┘               │
│                                                                      │
│                   Your apps                                          │ 20px weight 600, Ink
│                   Bake sale orders       Live       changed yesterday│ 17px; Live in
│                   Allotment rota   Not published  changed 3 weeks ago│ Marker green
└──────────────────────────────────────────────────────────────────────┘
```

Split layout (desktop), app ready and not published:

```
┌──────────────────────────────────────────────────────────────────────┐
│ Jigworks   Sunday Runs   Not published                    [Publish]  │ Door; 1px Ink 15% rule
├──────────────────────────┬───────────────────────────────────────────┤
│   ┌────────────────────┐ │ Phone  Computer  Open in a new tab  See the code
│   │ A sign-up sheet for│ │                                           │
│   │ my running club's  │ │   Only you can see this until you publish │ 15px, muted, centred
│   │ Sunday runs        │ │   ┌─────────────────────────────────┐     │
│   └────────────────────┘ │   │                                 │     │ Sheet: the app,
│                          │   │        Sunday Runs (live)       │     │ square corners,
│ │ Lovely idea. I'll make │   │                                 │     │ 1px Ink 15% edge
│ │ a page where runners   │   │                                 │     │
│ │ can see the next run…  │   │                                 │     │
│ │                        │   │                                 │     │
│ │ ✓ Choosing a starting  │   └─────────────────────────────────┘     │
│ │   point: A web page    │                                           │
│ │   that remembers things│                                           │
│ │ ✓ Naming your app:     │                                           │
│ │   Sunday Runs          │                                           │
│ │ ✓ Designing the…       │                                           │
│ │ ✓ Keeping track of…    │                                           │
│ │ ✓ Making sure it works │                                           │
│ │ Technical details      │                                           │
│ │                        │                                           │
│ │ Your app's ready…      │                                           │
│                          │                                           │
│  ┌──────────┐┌─────────┐ │                                           │ suggestion Notes,
│  │Add a     ││Make it  │ │                                           │ small, tilted
│  │waiting…  ││sportier │ │                                           │
│  └──────────┘└─────────┘ │                                           │
│   ┌────────────────────┐ │                                           │ composer Note
│   │ Ask for a change…  │ │                                           │
│   │             [Send] │ │                                           │
│   └────────────────────┘ │                                           │
└──────────────────────────┴───────────────────────────────────────────┘
```

Phone (390 px):

```
┌───────────────────────────┐
│ Jigworks        [Publish] │
│ Sunday Runs               │ status under the name, 15px
│ Not published             │
│  Chat          App        │ two words; active one in Ink
├───────────────────────────┤ weight 700 with a 3px Note-
│  ┌──────────────────────┐ │ yellow underline
│  │ A sign-up sheet for  │ │
│  │ my running club's…   │ │
│  └──────────────────────┘ │
│ │ Lovely idea. I'll make  │
│ │ a page where…           │
│ │ ✓ Choosing a starting…  │
│                           │
│  ┌─────────┐┌──────────┐  │
│  │Add a…   ││Make it…  │  │
│  └─────────┘└──────────┘  │
│  ┌──────────────────────┐ │
│  │ Ask for a change…    │ │
│  └──────────────────────┘ │
└───────────────────────────┘
App tab: the Sheet fills the width below a one-line strip with Phone/Computer and
See the code; the status line sits above the Sheet.
```

### How each state looks

**First build.** The canvas shows a Sheet with a to-do list written in Ink, titled with the current activity in 24 px weight 700 ("Designing the sign-up page…"). Each step is a line with a 20 px square box: ticked in Marker green when done (with the result on the same line, "Starting point: A web page that remembers things"), empty with a pen-dot caret for the running one. Under the list, a plain sentence: "3 of 5 things done". When the Build lands, the list Sheet is replaced by the app's Sheet (a 250 ms crossfade; instant under reduced motion). In the chat, the Agent's reply types in with the same steps ticking. The composer note is greyed to Note at 55% and says "The Agent is working…".

**Later Turn.** The app's Sheet stays, fully usable. Above it the status line changes to "Updating: adding a waiting list…" in Ink with a small Marker-green progress bar (4 px tall, 12 rem wide, filling by `progress`). No dimming: a sheet on a fridge doesn't fade while someone's writing a new one.

**Question.** The Agent's ink asks; beneath it two small Notes carry the answers ("My sign-in address", "A different address"), tilted ±2°. Tapping sticks one in as your message. The composer's placeholder becomes "Or write an answer…".

**Failure.** The Agent's reply gets a Marker-red margin stroke instead of the grey one, and its first line, in red, says "That didn't work. Your app hasn't changed." The "Making sure it works" step shows a red ✕ with "Couldn't fix it". The canvas status line says the same in red; the Sheet is unchanged. The suggestions "Try a different way" and "Leave it for now" are notes as usual.

**Published.** Pressing Publish lifts a Sheet (a centred dialog, square corners, 1 px edge, the Note's shadow) carrying the shared copy, with the Publish button in Ink (light) or Note yellow with Ink text (dark). After confirming, the Sheet shows "Sunday Runs is live", the link in 20 px weight 700, and "Copy the link" and "Done". The header status becomes "Live" in Marker green; the canvas status line becomes the link; the Publish button reads "Share". After a further change, the status reads "Live, with changes not yet published", the button "Publish changes", and the canvas line "People with the link have the earlier version."

**Phone and Computer.** Two plain words in the toolbar, the active one in weight 700 with a Note-yellow 3 px underline. Phone view narrows the Sheet to 24 rem.

**See the code.** A muted text button at the end of the toolbar; it swaps the Sheet's contents for `CodePeek`.

### Motion and reduced motion

Three movements: the note lifting and sliding on the first send (150 ms + 350 ms); a new note settling into the conversation (translate from 6 px up, 180 ms); the first-build crossfade (250 ms). Under `prefers-reduced-motion: reduce` all are instant. The tilted notes are static rotations, not animation.

### Review against the brief and the skill's defaults

- The first draft hung the app's Sheet from a round magnet that changed colour with publish status. Removed: it's a second toy on top of the notes, and status is already in the header and the status line. One memorable thing.
- The first draft gave the Agent's answer-choices a second note colour (pink). Removed: one note colour keeps the rule "yellow is you" clean; the choices are yellow because tapping one makes it yours.
- The first draft's dark mode was a charcoal door. Changed to a deep ink-blue (`#1B2341`): charcoal-plus-yellow drifts towards the skill's "near-black with one bright accent" default, and a navy door with white paper and yellow notes is a chosen scene.
- Thought about a handwriting face for the notes. No: handwriting fonts are the kitsch version of this idea. One legible family throughout, and the paper does the talking.
- Checked against the skill's list: no cream, no terracotta, no neon on black, no broadsheet, no card kit (the Sheet and the Notes are different materials with different edges, radii and one meaningful shadow), no caps eyebrows, no middle-dot strings, no `#111`, no monospace labels, no arrows on buttons.
- Checked against the typographic tells: the question isn't accented word-by-word; "Your apps" is a heading, not an eyebrow; no labels above content (the composer's prompt is the question itself).
- Checked against the words rule: tick boxes and plain sentences; the only technical lines are under "Technical details".

---

## Direction 3: "Stage directions"

A conversation with the Agent is already a two-hander: you speak, it replies, and in between it does things. The clearest form ever devised for that is the play script: the speaker's name, their line, and the stage directions in italic for what happens. This direction sets the whole Conversation as a script, in a reading serif on a stone-coloured page, with no bubbles, no cards and no boxes anywhere. The app sits on the right like a plate in a book, with a caption under it. Calm, literate, and trusting the reader.

### Tokens

**Colour** (light; dark in the right column)

| Name | Light | Dark | Role |
| --- | --- | --- | --- |
| Stone | `#EDEFE9` | `#1B1F27` | The page, everywhere. A cool pale stone, not cream; dark, an iron-gall blue-black. |
| Ink | `#1C2633` | `#E4E3DC` | All text. Iron-gall ink. |
| Plum | `#6B2D5C` | `#C98BB9` | The Agent's voice (its speaker name), the primary action (Make it, Send, Publish), links, focus, "Live". |
| Madder | `#B23A33` | `#E08078` | Failure only. |
| Rule | `#C9CCC3` | `#3A4150` | The one rule under the header, the baseline the composer sits on, dot leaders in Your apps. |

Muted text is Ink at 58% opacity. There are no fills: the only solid area besides the page is the primary button. No shadows, no borders, no backgrounds on text.

**Type**: one family, Literata, a serif made for reading on screens, with its optical-size axis giving display and text cuts from one file and a true italic for the stage directions.

```css
@import url("https://fonts.googleapis.com/css2?family=Literata:ital,opsz,wght@0,7..72,200..900;1,7..72,200..900&display=swap");
```

Set `font-optical-sizing: auto` on the root so each size gets its cut.

| Role | Setting |
| --- | --- |
| The question on the start page | 52 px, weight 500, line-height 1.1, letter-spacing −0.005em |
| Wordmark "Jigworks" (running head) | 17 px, weight 500, italic |
| App name (running head, centred) | 17 px, weight 600 |
| Dialogue (your lines and the Agent's) | 17 px, weight 400, line-height 1.6, max 60ch |
| Speaker names | 17 px, weight 600; "Agent" in Plum, "You" in Ink |
| Stage directions (steps, activity, captions) | 16 px, weight 400, italic, line-height 1.5 |
| The activity on the canvas while building | 30 px, weight 400, italic |
| Buttons | 16 px, weight 600 |
| Running-head status, Your apps statuses | 15 px, weight 400 |

**Shape and space**: a vertical rhythm of 27 px (17 × 1.6). Corners 4 px on the two button styles. Chat pane 30 rem wide on desktop, padding 32 px. The start page is a centred 36 rem column; its text is left-aligned within it. Dialogue is left-aligned, ragged-right, never justified.

**Principles**

1. Structure comes from the script form (name, line, direction), never from boxes. If you reach for a border or a fill, find the typographic device instead.
2. Italic means "what's happening": every step, every status, every caption is a stage direction.
3. One colour, Plum, belongs to the Agent and to the things it offers you to press. Everything you say is in Ink.
4. The page is quiet and even; the only big type is the question at the start and the activity while the first build runs.

### The one memorable thing: the Conversation as a script

Each exchange is set like this (no bubbles, no backgrounds):

```
You
A sign-up sheet for my running club's Sunday runs.

Agent
Lovely idea. I'll make a page where runners can see the next run and
put their names down, and you can see who's coming.
    (Choosing a starting point: a web page that remembers things.)
    (Naming your app: Sunday Runs.)
    (Designing the sign-up page…)
```

Speaker names on their own line, weight 600, with 27 px above each new speaker. The Agent's steps are italic stage directions in parentheses, indented 1.5 rem: running ones end with an ellipsis; done ones are muted and state the result after a colon; a fixing one reads "(Found a problem, fixing it, try 1 of 3…)"; a failed one is in Madder: "(Couldn't fix it after three tries. Your app hasn't changed.)". After the steps, "Technical details" is an italic muted link that reveals `step.detail` lines, also as directions. The Agent's outro ("Your app's ready. Have a go…") follows as a second paragraph of its line.

The canvas continues the form: under the app sits an italic caption, like a plate's caption in a book: "Only you can see this until you publish." It's where every canvas state is told.

The hand-off from start page to split: the question and the composer's baseline fade out (200 ms), and the split fades in (250 ms) with your sentence already set as the first "You" line and the canvas showing the first stage direction. Under reduced motion both are instant.

### Wireframes

Start page (desktop):

```
┌──────────────────────────────────────────────────────────────────────┐
│ Jigworks                                                             │ running head, italic
│ ──────────────────────────────────────────────────────────────────── │ 1px Rule
│                                                                      │ Stone
│                                                                      │
│              What would you like to make?                            │ 52px Literata
│                                                                      │
│              Say it in your own words. The Agent builds it, and      │ 17px, ≤60ch
│              you can change anything by asking.                      │
│                                                                      │
│              A sign-up sheet for my running club…          Make it   │ textarea with no box,
│              ───────────────────────────────────────────────────     │ a 1px Rule baseline;
│                                                                      │ Plum button to the
│              For example,                                            │ right
│                a sign-up sheet for my running club's Sunday runs,    │ italic list; each
│                a page where neighbours can borrow my lawnmower,      │ item a Plum link
│                or a rota for who's cleaning the office kitchen.      │
│                                                                      │
│              Your apps                                               │ 17px weight 600
│              Bake sale orders . . . . . . . . . . . . . . . . Live   │ dot leaders (Rule);
│                changed yesterday                                     │ small print under,
│              Allotment rota . . . . . . . . . . . . . Not published  │ muted
│                changed 3 weeks ago                                   │
└──────────────────────────────────────────────────────────────────────┘
```

Split layout (desktop), app ready and not published:

```
┌──────────────────────────────────────────────────────────────────────┐
│ Jigworks               Sunday Runs                 Not published  Publish
│ ──────────────────────────────────────────────────────────────────── │ one Rule, full width
│                            │ Phone  Computer   Open in a new tab  See the code
│ You                        │                                         │ toolbar: text links
│ A sign-up sheet for my     │     ┌─────────────────────────────┐     │ in 15px; active
│ running club's Sunday      │     │                             │     │ view in Plum
│ runs.                      │     │      Sunday Runs (live)     │     │
│                            │     │                             │     │ the app, square,
│ Agent                      │     │                             │     │ 1px Rule edge
│ Lovely idea. I'll make a   │     │                             │     │
│ page where runners can see │     │                             │     │
│ the next run and put their │     └─────────────────────────────┘     │
│ names down…                │     Only you can see this until you     │ italic caption,
│   (Choosing a starting     │     publish.                            │ centred under the
│   point: a web page that   │                                         │ app
│   remembers things.)       │                                         │
│   (Naming your app:        │                                         │
│   Sunday Runs.)            │                                         │
│   (Designing the sign-up   │                                         │
│   page.)                   │                                         │
│   (Keeping track of who's  │                                         │
│   coming.)                 │                                         │
│   (Making sure it works:   │                                         │
│   all good.)               │                                         │
│   Technical details        │                                         │
│                            │                                         │
│ Your app's ready. Have a   │                                         │
│ go…                        │                                         │
│                            │                                         │
│ You might ask for          │                                         │ italic lead-in, then
│   a waiting list when      │                                         │ suggestions as Plum
│   it's full,               │                                         │ links in a list
│   a sportier look, or      │                                         │
│   an email when someone    │                                         │
│   signs up.                │                                         │
│                            │                                         │
│ Ask for a change…    Send  │                                         │ baseline composer,
│ ────────────────────────── │                                         │ Rule under it
└────────────────────────────┴─────────────────────────────────────────┘
```

The chat pane and the canvas share the Stone page; a single vertical Rule separates them. Your lines and the Agent's lines are the same Ink, the same size; only the speaker name tells them apart, and the Agent's name is Plum.

Phone (390 px):

```
┌───────────────────────────┐
│ Jigworks          Publish │ running head
│ Sunday Runs               │
│ Not published             │
│ ───────────────────────── │ Rule
│ Conversation     The app  │ two words, active in Plum
│                           │ weight 600; the other muted
│ You                       │
│ A sign-up sheet for my    │
│ running club's Sunday     │
│ runs.                     │
│                           │
│ Agent                     │
│ Lovely idea. I'll make a  │
│ page where…               │
│   (Choosing a starting    │
│   point: a web page that  │
│   remembers things.)      │
│                           │
│ Ask for a change…    Send │
│ ───────────────────────── │
└───────────────────────────┘
The app tab: the app full-width with its italic caption beneath, and the
Phone/Computer and See the code links above it.
```

### How each state looks

**First build.** The canvas is empty Stone with one large italic line in the middle, the current activity at 30 px: *Designing the sign-up page…*. Under it a 1 px Rule, 20 rem wide, with a Plum segment filling left to right by `progress`. Nothing else: the steps already read as stage directions in the script on the left. When the Build lands, the line and rule fade and the app appears with its first caption (250 ms crossfade; instant under reduced motion). The composer is disabled and its placeholder reads "The Agent is working…"; its baseline Rule stays.

**Later Turn.** The app stays on the canvas, fully usable. Its caption changes to the activity in italic Plum: *Updating: adding a waiting list…*, with the same short progress Rule beneath the caption. When it finishes the caption returns to its publish-state text.

**Question.** The Agent's line asks; its answers follow as a stage direction, *(choose one)*, then two outlined Plum buttons (1 px Plum border, 4 px corners, Plum text) side by side with 12 px between. The composer's placeholder becomes "Or write an answer…".

**Failure.** The failed step is a Madder italic direction: *(Couldn't fix it after three tries. Your app hasn't changed.)*; the Agent's outro follows in Ink. The caption under the app changes to Madder italic: *That didn't work. Your app is as it was.* The suggestions "Try a different way" and "Leave it for now" appear in the usual italic lead-in form. No red anywhere else.

**Published.** Pressing Publish shows the shared copy as a centred panel on Stone, framed only by a 1 px Rule, with "Not yet" as a Plum text link and "Publish" as the solid Plum button. After confirming, the running-head status reads "Live" in Plum; the caption reads *Published 2 November at 10:14. Anyone with the link can use it: sunday-runs.jigworks.app* with "Copy the link" as a Plum link; the Publish button reads "Share". After a later change: status "Live, with changes not yet published", button "Publish changes", caption *People with the link have the version from 10:14. Publish to give them this one.* (Format `published.at` with the browser's locale, day and time only.)

**Phone and Computer.** Two words in the toolbar; the active one in Plum weight 600, the other muted. Phone view narrows the app to 24 rem and keeps the caption.

**See the code.** A muted link at the end of the toolbar; it replaces the app with `CodePeek` and sets the caption to *The code, for anyone who wants it.*

### Motion and reduced motion

Two movements: the start-to-split crossfade (200 + 250 ms) and the first-build crossfade (250 ms). Progress rules change width with a 200 ms transition. Under `prefers-reduced-motion: reduce` all are instant. No typing effects, no pulsing on the running direction; the ellipsis is the signal.

### Review against the brief and the skill's defaults

- The first draft set speaker names in small caps and the Agent's stage directions as "WORD — fragment" lines with a spaced em dash. Both are on the skill's tell list (caps labels, the spaced-dash label). Changed to sentence-case names in weight 600 and parenthesised directions, which is also how real scripts set them.
- The first draft used hairline rules between every exchange and around the canvas, which turned it into the "broadsheet" default. Reduced to three places where a rule carries information: the one under the running head, the composer's baseline (it's a line to write on), and the dot leaders in Your apps (it's a contents list). The chat and the canvas are divided by a single vertical Rule and nothing else.
- The first draft's accent was a teal-green; changed to Plum so the three directions don't share a green, and because Plum next to iron-gall Ink on cool Stone is a chosen combination rather than a tasteful default.
- Considered a rubber-stamp "Published" mark over the app's corner. Dropped: it would be a second memorable thing, and stamps are caps by nature. The caption tells the date instead, in the same italic voice as everything else.
- Checked against the skill's list: Stone (`#EDEFE9`) is cool, not the warm cream default, and the accent is Plum, not terracotta; dark mode is a blue-black with the same Plum and Madder, not neon; no cards, no shadows; no caps eyebrows; no middle-dot strings; no `#111` (Ink is a chosen blue-black); no monospace outside `CodePeek`; no arrows on links.
- Checked against the typographic tells: no single accented word in the question; the only "label above content" is a speaker name, which is the content's structure; the ideas list is a sentence, not three chips.
- Checked against the words rule: steps are plain sentences in parentheses; the Template's name only appears under "Technical details".
