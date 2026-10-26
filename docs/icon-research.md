# Gantry icon research

Research date: 2026-10-26. Stage: Research Icon Ideas.

## Recommendation

Explore an **original Routed G** first: one substantial, open G-shaped route with
a single squared-off terminal. It connects the name to the product's graph-driven
process without drawing an entire workflow. Compare it with **Gantry Frame** and
**Review Loop** before selecting a winner. Start in black and white; test violet
as a color treatment only after the shape succeeds.

The earlier planning handover proposed a violet Lucide Workflow icon. Keep that
as a useful baseline for familiarity and implementation effort. An original mark
has a better opportunity to identify Gantry independently of a common UI symbol.
This is a design recommendation, not a selection decision or a measured result.

## Product brief and research method

Gantry's README describes “A Graph for your agents to follow,” configurable stages,
conditional paths, review loops, and visibility across tickets and workspaces.
The icon should communicate **deliberate progress through a process**. It should
feel precise, dependable, and approachable to developers using several different
coding agents. A robot head would overemphasize the agent; a terminal would
underrepresent the graph; an atom would retain the Electron association.

Repository context reviewed:

- `README.md`: product positioning and the future README logo placement.
- `desktop/src/components/gantry/workspace.tsx`: current Gantry label uses a
  violet layout-list icon.
- `desktop/src/components/home.tsx`: existing pink/violet/sky visual accents.
- `desktop/package.json`: macOS and Linux reference `electron/icon.png`, build
  resources are under `electron`, and Windows targets NSIS without an explicit
  Windows icon setting. The packaged file list is restrictive, so runtime asset
  inclusion needs checking during implementation.

The comparison below uses five widely recognized, successful YC alumni and two
closer automation/developer-tool peers. YC membership and batches were checked
against individual YC company profiles. This is a purposive reference set, **not
a current valuation ranking**: the YC top-companies endpoint returned only a
directory shell in this research environment.

Official brand/newsroom material is preferred over logo aggregators. Shape
descriptions and Gantry lessons are design analysis of published identities;
explicit brand rules are identified separately. Famous companies' success does
not establish that their logos caused growth. No recognition study, conversion
experiment, trademark search, or rendered Gantry sample evaluation was performed.

## What successful YC companies use

| Company and verified YC batch | Identity approach                                                                                                            | Why it is useful to study                                                                                                                                                                                 | Application to Gantry                                                                                                                                              |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Stripe — S09**              | Custom lowercase wordmark, with a consistent slanted character; controlled slate, blurple, and white versions.               | Recognition can come from typography and a narrow palette rather than a literal picture of the product. Stripe explicitly prescribes its three wordmark colors and background usage.                      | Pair a strong compact symbol with the full Gantry name in the README. Use intentional letter spacing; do not squeeze the whole word into an app tile.              |
| **Airbnb — W09**              | The Bélo: an open, continuous, looped symbol paired with a wordmark; a warm, recognizable brand color.                       | A compact abstract form can carry more than one association without illustrating the whole service. Airbnb's official history dates the Bélo introduction to July 2014.                                   | Let a route suggest both a G and a process. Preserve a readable opening and avoid Airbnb-like pointed loops or heart geometry.                                     |
| **Dropbox — S07**             | Geometric open-box glyph with wordmark; the current system also uses a glyph-containing “Tab” plane.                         | A small repeatable geometry supports both a standalone identifier and a larger layout system. Its guidelines explicitly distinguish the full logo from the Tab.                                           | A few modular forms can connect the icon, README lockup, and UI. A brand system can expand from a simple mark without making the app icon elaborate.               |
| **Reddit — S05**              | Snoo's head inside an OrangeRed conversation bubble, usually paired with the wordmark.                                       | A mascot works when it has a distinctive silhouette and an intentional connection to community. Reddit explicitly names #FF4500 and describes the icon as shorthand for Reddit.                           | Warmth is valuable, but a mascot would need substantially more character-development work. A friendly corner radius can provide approachability more economically. |
| **Instacart — S12**           | A simplified carrot symbol and wordmark, strongly associated with grocery through its familiar object and orange/green cues. | A literal metaphor can work when one object stands for the category. It need not show a cart, store, delivery vehicle, and shopping list together.                                                        | If using the product name literally, reduce a gantry crane to its supporting frame and carriage. Avoid a detailed construction illustration.                       |
| **Zapier — S12**              | A compact orange asterisk-like symbol with a wordmark.                                                                       | An automation company can use an abstract mark rather than a miniature connection diagram. This is a useful near-category comparator for Gantry.                                                          | A graph reference should be distinctive, not just the standard three-node workflow glyph. Avoid orange radial spokes that invite comparison with Zapier.           |
| **Supabase — S20**            | A compact green lightning-bolt symbol with wordmark, supplied in light and dark logo kits.                                   | A developer platform can use one bold energetic silhouette while its product remains technically complex. Supabase explicitly controls wordmark colors and restricts modifications to its brand elements. | Keep the mark bold enough for a favicon. Create a unique route or structure rather than borrowing the increasingly common bolt metaphor.                           |

### Patterns worth adopting

1. **One memorable feature.** A Bélo loop, box construction, Snoo antenna, carrot,
   asterisk, or bolt offers a visual anchor. Gantry needs an equally concise anchor.
2. **Separate mark and wordmark jobs.** App launchers favor a compact symbol;
   documentation benefits from the name. They can share one identity without
   sharing the exact same layout.
3. **Color reinforces form.** Recognizable brands control a small palette, but a
   shape should remain identifiable in monochrome. Purple alone is not ownership.
4. **Geometry becomes a system.** Repeated angles, corners, and proportions make
   assets coherent across contexts; copying the same PNG everywhere is insufficient.
5. **Literal and abstract both work.** The deciding factor is a strong, ownable
   execution and consistent use, not an automatic preference for abstraction.
6. **Avoid survivorship shortcuts.** These examples suggest useful principles;
   they do not prove that minimal logos universally outperform detailed ones.

## Twelve distinct design directions

These are construction briefs for the sample stage, not finished artwork. Colors
are optional exploration palettes, not approved brand values.

| #   | Direction              | Concrete construction and meaning                                                                                                                                | Initial treatment                                            | Main failure risk and small-size adjustment                                                                                                       |
| --- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Routed G**           | One open, squared G-shaped band; its inward horizontal terminal represents a stage destination. Name recognition and directed process in one silhouette.         | White mark on violet `#6D28D9`; flat black counterpart.      | Can look like a generic G or Google-derived monogram. Use original proportions, one terminal, and a wide opening; remove any extra node at 16 px. |
| 2   | **Gantry Frame**       | Two upright supports and a top beam, with one offset suspended carriage formed as a solid block. A literal gantry that supports controlled work.                 | Near-black on warm white; test violet as a secondary option. | Can resemble a bridge, pi symbol, or industrial supplier. Keep a distinctive offset carriage; omit cables, hooks, and feet at all sizes.          |
| 3   | **Review Loop**        | A broad, nearly rectangular return path with a deliberate opening and an inward-facing terminal, suggesting iteration before delivery.                           | Violet on white; reversed for a dark tile.                   | Can be mistaken for refresh, sync, or a loading indicator. Avoid two circular arrowheads; use an asymmetric rectangular path and one terminal.    |
| 4   | **Branch and Merge**   | A single path splits into two short routes and recombines into a substantial right-side endpoint. A decision followed by verification.                           | Solid monochrome; optional sky-blue tile.                    | Generic Git/network symbol and disappearing branches. Limit to one split and one join, with generous negative space.                              |
| 5   | **Stage Stair**        | Three connected, rising solid steps with a continuous lower edge. Deliberate progress through defined stages.                                                    | Deep violet on pale lilac.                                   | Reads as analytics, signal strength, or growth marketing. Connect the steps visibly and keep unequal terminal lengths as a signature.             |
| 6   | **Switch Track**       | Two thick parallel rails with one diagonal switching segment, arranged into a compact square. Explicit routing and user control.                                 | Ink on white, with optional teal tile.                       | May imply transport or equalizer controls. Keep the diagonal dominant and eliminate extra junction dots.                                          |
| 7   | **Handoff Link**       | Two offset, interlocking open brackets with one shared channel of negative space. Work transfers between stages and agents.                                      | Monochrome first; violet and lilac in larger versions only.  | Can read as chain link, crypto, or “code” brackets. Use asymmetric brackets and preserve a broad separating channel at 16 px.                     |
| 8   | **Process Ribbon**     | One broad folded band makes two right-angle turns, with a single cut exposing the next stage. A reusable process taking shape.                                   | Flat violet; optional two-tone faces for large artwork.      | Easily resembles Linear-like stripes or a generic ribbon. Avoid circles/diagonal hatching; ensure the flat silhouette works without shading.      |
| 9   | **Workspace Keystone** | A compact arch of three solid blocks surrounding an open central workspace, with a distinctive central notch. Gantry provides structure around development.      | Deep ink and warm white.                                     | Architecture/real-estate association. Favor engineered rectangular blocks, not a house roof; remove secondary seams in the favicon.               |
| 10  | **Node Constellation** | Three large, unequal square nodes connected by one L-shaped spine, leaving one quadrant empty. A graph you can recognize instantly.                              | Violet monochrome; no multicolor node statuses.              | Generic share/workflow icon, close to the Lucide baseline. Own the node proportions and empty quadrant; connect shapes without hairlines.         |
| 11  | **Control Aperture**   | Four offset solid corner pieces frame a single open route through the center. Visibility and boundaries around an agent's work.                                  | Dark violet on pale background.                              | Reads as crop, scan, or camera focus. Make the open route asymmetric; avoid four identical detached crop corners.                                 |
| 12  | **Modular G Tiles**    | Four or five solid tiles define a G through negative space, with one displaced terminal tile indicating the next stage. A graph assembled into a named identity. | Black and white first; one violet tone for the whole mark.   | Looks pixelated or like a generic grid app; gaps collapse at 16 px. Use fewer, larger tiles and avoid gradients or separate tile colors.          |

### Shortlist and comparison rubric

Recommended sample order: **1 Routed G**, **2 Gantry Frame**, **3 Review Loop**.
These test meaning through the name, the supporting-structure metaphor, and the
product's review behavior respectively. Include **10 Node Constellation** or the
planned Lucide Workflow treatment as a familiar comparison baseline.

Score rendered candidates from 1–5 on each criterion, then calculate
`sum(weight × score / 5)`. Weights sum to 100. Do not fill in scores before samples
exist; apparent simplicity on paper can hide small-size failures.

| Criterion                        | Weight | Evidence to gather                                                                       |
| -------------------------------- | ------ | ---------------------------------------------------------------------------------------- |
| Distinctive silhouette           | 30     | Recognizable without name or color; compare alongside nearby developer-tool icons.       |
| Actual-size legibility           | 25     | Inspect raster output at 16, 20, 24, 32, 48, 128, and 256 px without zooming.            |
| Fit to Gantry's name and process | 20     | Ask a reviewer what the mark suggests before explaining it.                              |
| Consistency across contexts      | 15     | Same identity on a light README, dark README, app tile, and standalone monochrome glyph. |
| Production simplicity            | 10     | Clean vector paths; deterministic local exports; manageable attribution requirements.    |

Reject a candidate regardless of total if its key opening disappears at 16 px or
if its silhouette is easily mistaken for an established product. The comparison
is a design review, not a substitute for a formal name/mark clearance process.

## Practical design and production best practices

- **Design in one color first.** A core route, frame, or loop must survive flat
  black, white, and grayscale. Add color after the silhouette passes.
- **Use substantial forms and visible gaps.** Start on a 24-unit construction grid
  with roughly 2.5–3-unit bands and generous channels, then adjust optically. These
  are starting values, not platform requirements; evaluate the actual raster.
- **Keep one dominant idea.** Do not combine a G, crane, graph, robot, checkmark,
  and terminal in one icon. Avoid status dots that imply live execution state.
- **Optically center the mark.** Open shapes and offset carriages often need
  adjustment beyond mathematical centering. Compare perceived weight with other
  icons in a launcher row.
- **Preserve breathing room.** Start with the symbol occupying about 65–75% of the
  tile width; tune by eye. This is a proposed design range, not an Apple safe-zone
  specification. Keep important geometry away from clipping boundaries.
- **Separate the glyph from platform containers.** Maintain an unmasked vector
  master. Apple now recommends unmasked layers for its layered icon pipeline;
  an Electron PNG/ICNS pipeline is different. Check the actual packaged result
  instead of assuming that native Icon Composer behavior applies to Electron.
- **Prefer clean geometry to baked-in effects.** A restrained gradient can be
  tested later, but glows, tiny highlights, and shadows must not define the mark.
  Apple's current guidance favors simple shapes and system-provided effects.
- **Do not put “Gantry” inside the launcher tile.** A custom G may be essential to
  the identity; the full name is not readable at favicon sizes. Use a separate
  horizontal or stacked wordmark lockup for documentation.
- **Use accessible embedding.** A standalone README image can use `alt="Gantry"`.
  A decorative mark adjacent to equivalent text should use empty alt text; icon-only
  controls need an accessible name. Logos have contrast exceptions under WCAG,
  but high visual contrast is still a practical design target.
- **Test both GitHub themes.** Use a transparent theme-safe glyph or explicit
  light/dark assets with a `<picture>` element. A white mark must not disappear on
  the light README; do not bake a large white rectangle into a dark-theme lockup.
- **Produce platform assets deliberately.** Plan an SVG master and a 1024 px PNG
  export, then generate appropriate ICNS/ICO and Linux PNG sizes as required by
  the installed builder. Inspect Windows installer/taskbar, macOS Dock/Finder,
  Linux launcher, and browser favicon outputs. These are future checks, not checks
  already run. No current electron-builder documentation page was successfully
  retrieved; verify export requirements against the installed toolchain.
- **Keep assets local and reproducible.** Bundle the chosen logo, record its source
  and export process, and avoid runtime logo/CDN requests. Keep generated output
  limited to needed formats and sizes rather than checking in every experiment.
- **Respect source provenance.** YC company marks are references, not reusable
  components. If the Lucide option is used or adapted, retain the applicable
  copyright and permission notices. Its ISC permission allows modification and
  distribution, but does not make a common glyph distinctive to Gantry.

## Three widely used skills that can help

Discovery started with the skills.sh leaderboard, then individual listings and
the upstream `SKILL.md` files were read. Figures below are **directory-reported,
rounded snapshots**, retrieved on the research date; installs are not unique users
or evidence that a skill produces good logos. GitHub star counts shown here are
also directory-reported, not independently reconciled against GitHub's API.
Official Anthropic/Vercel ownership and readable upstream instructions provide
additional source-quality signals beyond popularity.

### 1. Anthropic `frontend-design` — visual direction and contextual presentation

- Popularity: approximately **1.0M installs**; source repository approximately
  **183.5K stars**.
- Useful guidance: ground the design in the product, choose a deliberate visual
  direction, spend visual boldness in one place, and critique generic defaults.
- Gantry use: present sample marks with the real Gantry headline, graph imagery,
  light/dark surfaces, and consistent typography. Assess the identity in context.
- Limit: principally an interface-design skill, not an icon export or logo
  distinctiveness evaluator. Do not turn this ticket into a UI redesign.
- [Listing](https://skills.sh/anthropics/skills/frontend-design) ·
  [Upstream instructions](https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md)

```sh
npx skills add https://github.com/anthropics/skills --skill frontend-design
```

### 2. Anthropic `canvas-design` — static concept boards and visual iteration

- Popularity: approximately **122.0K installs**; source repository approximately
  **183.5K stars**.
- Useful guidance: articulate a visual philosophy, communicate with form and
  negative space, refine spacing, and make a second craft-focused pass.
- Gantry use: build a comparison board with actual-size silhouettes, a large
  construction view, and brief labels. Particularly useful for testing whether
  the routed G and frame feel like distinct identities.
- Limit: its documented outputs are Markdown, PNG, and PDF. It does not provide
  a production SVG/ICNS/ICO pipeline; editable vector artwork and tiny-size checks
  still need explicit work. Its art/poster emphasis can encourage too much detail.
- [Listing](https://skills.sh/anthropics/skills/canvas-design) ·
  [Upstream instructions](https://github.com/anthropics/skills/blob/main/skills/canvas-design/SKILL.md)

```sh
npx skills add https://github.com/anthropics/skills --skill canvas-design
```

### 3. Vercel `web-design-guidelines` — integration and accessibility review

- Popularity: approximately **782.3K installs**; source repository approximately
  **33.0K stars**. The all-time leaderboard rounded installs slightly differently.
- Useful guidance: fetch the current Web Interface Guidelines and review specified
  UI files, reporting concrete file/line findings.
- Gantry use: review any changed logo-bearing web components for image labeling,
  sizing, theme behavior, and interaction/accessibility issues that the fetched
  rules cover. Manually check GitHub Markdown rendering as a separate step.
- Limit: a code-review skill, not a logo generator, visual originality test, or
  native desktop packaging validator. It fetches remote review rules; inspect the
  fetched content before applying it. The listing showed a Socket warning alongside
  other passing audits; this brief does not treat directory badges as a guarantee.
- [Listing](https://skills.sh/vercel-labs/agent-skills/web-design-guidelines) ·
  [Upstream instructions](https://github.com/vercel-labs/agent-skills/blob/main/skills/web-design-guidelines/SKILL.md)

```sh
npx skills add https://github.com/vercel-labs/agent-skills --skill web-design-guidelines
```

Suggested sequence for later work: canvas-design for static comparisons,
frontend-design for contextual presentation, web-design-guidelines for integration
review. Commands are documented for handoff; none of these three skills was
installed or executed in this research stage. The locally configured find-skills
skill was used for discovery guidance.

## Sources and evidence boundaries

### YC membership and cohort

- [Stripe](https://www.ycombinator.com/companies/stripe),
  [Airbnb](https://www.ycombinator.com/companies/airbnb),
  [Dropbox](https://www.ycombinator.com/companies/dropbox),
  [Reddit](https://www.ycombinator.com/companies/reddit),
  [Instacart](https://www.ycombinator.com/companies/instacart),
  [Zapier](https://www.ycombinator.com/companies/zapier), and
  [Supabase](https://www.ycombinator.com/companies/supabase): profiles retrieved.
  Used for batch/membership only; profile business statistics may be stale.
- [YC top-companies endpoint](https://www.ycombinator.com/topcompanies/): returned
  a directory shell; no present-day rank or valuation was extracted.

### First-party identity references

- [Stripe newsroom media assets](https://stripe.com/newsroom/brand-assets):
  resolved to its newsroom information page; explicitly describes wordmark
  variants and links a logo kit. The guessed `/newsroom/resources` URL returned 404.
- [Airbnb official history](https://news.airbnb.com/about-us/): dates the Bélo
  launch and includes identity imagery. No unpublished brand guidelines inferred.
- [Dropbox logo system](https://brand.dropbox.com/logo) and
  [brand usage rules](https://www.dropbox.com/branding): full-logo/Tab distinction,
  consistency, and restrictions on modifying or incorporating its mark.
- [Reddit brand](https://redditinc.com/brand): explicit Snoo/conversation-bubble
  construction, OrangeRed value, and wordmark relationship.
- [Instacart media hub](https://www.instacart.com/company/press): links its
  [official brand guide](https://heyitsinstacart.com/). The guide exposed only a
  JavaScript shell; no numerical palette, clear-space, or minimum-size rules
  were extracted from it.
- [Zapier brand guide](https://zapier.com/brand): exposed a title-only shell.
  Its entry uses the published identity as a formal reference, not extracted
  proprietary dimensions or color specifications.
- [Supabase brand assets](https://supabase.com/brand-assets): official light/dark
  logo kits and explicit wordmark/brand-use rules.

### Production and skill references

- [Apple app-icon guidance](https://developer.apple.com/design/human-interface-guidelines/app-icons.md):
  retrieved Markdown, including 2026 updates; simplicity, text restraint, consistent
  identity, layered/unmasked artwork, and 1024 px macOS layout size. Native layered
  recommendations must not be confused with confirmed Electron capabilities.
- [Lucide license](https://lucide.dev/license): ISC terms plus the separate MIT
  notice for listed Feather-derived icons. Check the actual asset's provenance.
- [skills.sh leaderboard](https://skills.sh/), the three individual listings, and
  their upstream instructions linked above: used for skill scope and popularity.

## Handoff

The next sample stage has twelve construction briefs, a three-direction shortlist,
a familiar baseline, and a weighted review rubric. It should show the shortlist at
actual favicon and launcher sizes as well as in README lockups, then record the
selection rationale. Production integration should follow the chosen sample.

This research artifact is the only repository change in this stage. Verification
consists of source retrieval, repository-context review, Markdown formatting, and
diff inspection. Application tests and packaged-platform visual checks were not
run for this documentation-only research change.
