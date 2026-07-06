# Delight, Hooks, and Feature Food

> Positioning review deliverable (July 2026). The Hooked-model analysis of DorkOS's engagement loop, the first-time and daily-ritual moments worth engineering, and a catalog of delightful/fun/silly things (the "Tesla easter egg" list). Companion frames: StoryBrand and luxury codes live in `02-positioning.md` §8. Incorporation map at the end says what graduates into the GTM plan vs stays here as a parts bin.

## 1. The hook loop DorkOS already has (Hooked, applied)

Nir Eyal's loop is Trigger → Action → Variable Reward → Investment. Most dev tools have to fake this. DorkOS's core product IS the loop, which is rare and worth engineering deliberately:

- **External trigger:** the product literally sends them. A Telegram ping ("Atlas finished. PR #47 ready.") is the canonical external trigger, and unlike growth-hacked notifications it carries real news the user asked for. The morning review is the ritualized version.
- **Internal trigger:** two, both strong. _Anticipatory curiosity_ ("I wonder what the fleet did") and _idea capture_ ("I just thought of something; hand it to an agent before I lose it"). Marketing should name these feelings; the product should shorten the distance from feeling to action (quick-capture from phone/Obsidian).
- **Action:** open the cockpit; reply to the agent; hand off one task.
- **Variable reward:** built-in and honest. Agent runs genuinely vary (did it fix the bug? what did it find at 2am? what did it cost?). This is the rewards-of-the-hunt slot machine, except the payout is finished work. Rewards of self: fleet mastery, a green run history. Rewards of tribe: named agents with personalities; sharing fleet screenshots.
- **Investment:** every named agent, installed skill, configured schedule, bound channel, and accumulated memory is stored value that makes the next trigger richer and the product stickier. The marketplace and personality system are investment mechanics wearing feature clothes.

**Design rule:** never counterfeit any phase. No fake scarcity, no streak guilt, no notification spam: the honest loop is stronger than the growth-hacked one, and the audience's dark-pattern detectors are elite. (Hooked, pro-human edition: the habit we build is _reviewing your team's work_, not _checking an app_.)

## 2. First-time user experience: the four moments that matter

In loop order, these are the FTUE investments with the highest return; they overlap the GTM's 5-minute path and sharpen it:

1. **The recognition moment (reward, minute 1):** on first boot, DorkOS finds existing sessions: "Found 47 sessions across 6 projects. Your agents have been busy; now you can see them." The single strongest "it already knows me" beat and it ships today; polish the copy and the count-up animation.
2. **The naming ceremony (investment, minute 2):** first agent creation is a ritual, not a form. Name, color, icon, one personality slider, and a one-line manifest signature ("Atlas joined your fleet"). Naming is the highest-leverage investment mechanic in the product: named things are kept.
3. **The first handoff (action, minute 3-4):** one task, scheduled tonight, phrased by the UI as a handoff ("Give Atlas the night shift"). End state on screen: "Atlas runs at 2:00am. You'll hear about it."
4. **The first morning (trigger + reward, day 2):** the make-or-break loop closure. The Telegram ping and a **morning briefing** view: "While you were away: 1 PR opened, 14 tests added, one question waiting, $1.12." If day 2 lands, the habit exists; if nothing happens overnight on day 1, we lost the loop, so the FTUE must ensure _something_ is scheduled before the user leaves.

## 3. The daily ritual (startup delight)

- **The morning briefing** as a first-class surface (cockpit home on first open of the day): what happened, what needs you, what it cost. Calm, newspaper-like, three lines. This is the retention feature; everything else in this doc is seasoning.
- **Status-strip presence:** small time-aware touches ("Fleet quiet. 3 schedules armed for tonight."), never blocking, never cute more than once a day.
- **Fleet uptime line** ("Your fleet has been on duty 34 days"): pride without streak-guilt; it never resets punitively, it just counts.

## 4. The easter-egg and delight catalog (feature food)

Filter for everything below: _a tool, not a toy_. Delight must cost the operator zero seconds, be discoverable rather than intrusive, skippable forever, and on-brand (dry, precise, warm). Tiered by build cost.

### Tier 1: hours each (do during launch polish)

1. **Personalized boot line:** first open of the day, the cockpit's brief boot flicker reads "DorkOS. Good morning, Dorian." (name from git config). Once per day, 800ms, gone.
2. **Spinner verbs, DorkOS edition:** loading states rotate dry lines: "waking the fleet", "consulting the org chart", "negotiating with cron", "herding dorks".
3. **The 2:47am moment:** if the cockpit is open at exactly 2:47am, a one-time-ever toast: "This is the hour we were built for." (2:47 is the brand's origin-story timestamp.)
4. **`dorkos why`:** CLI prints the thesis, ten lines, beautifully: "Intelligence doesn't scale. Coordination does. ..." `dorkos who` lists your fleet like a crew manifest.
5. **Thank-you handling:** DorkBot has three dry responses to "thank you" ("It's what we're here for." / "The fleet noticed." / "Logged, with appreciation.").
6. **Release-notes last line:** every release blog post ends with a one-line message from the fleet ("11 agents contributed to this release. None of them slept.").
7. **Konami code** in the cockpit: the topology graph does one synchronized pulse and every agent avatar blinks. Nothing else. The restraint IS the joke.

### Tier 2: a day or two each (post-launch, weeks 4-8)

8. **Agent birthdays:** one year (or 100 days, alpha-appropriate) after registration, the agent's avatar wears a tiny party hat for the day. No notification; you just notice.
9. **The morning paper skin:** the morning briefing has an optional "THE DAILY DORK" masthead rendering: your fleet's night as a tiny front page. Screenshot-bait that markets itself.
10. **Idle constellation:** after long idle, the topology graph drifts gently like a star map, agents twinkling by health. A screensaver you leave on the second monitor (which is also a live status display, which is also an ad in every office background).
11. **`/dev/fleet` route:** the actual DorkOS development fleet (the agents that build DorkOS) with their real commit counts and uptime. Dogfood as easter egg; press will find it and write about it.
12. **First-blood moments:** quiet, once-ever celebration lines in run history: first agent-opened PR ("First PR. They grow up so fast."), first overnight fix, first inter-agent message. Once, then never again: rarity keeps it luxury, not gamification.
13. **Crew numbers:** every install gets a sequential crew number shown in About ("Crew member #214"). Early numbers become status as the crew grows (the scarcity lever that costs nothing and lies to no one).
14. **Sound, off by default:** one optional, beautiful, sub-second completion chime designed once (not a notification sound; a _craft_ sound, like a camera shutter).

### Tier 3: bigger, only if they earn their keep

15. **Fleet wrapped:** a yearly (or quarterly, alpha-speed) shareable recap: tasks run, PRs shipped, longest night shift, favorite agent. The single best organic-sharing artifact available; build after there are users to wrap.
16. **Agent lore system:** optional flavor text in SOUL.md surfaces occasionally in agent self-descriptions. Ships personality; risks cringe; prototype with DorkBot only.
17. **The hardware status light:** a documented recipe (not a product) for wiring the fleet status to a desk LED via the API/MCP. The dorkiest possible accessory, community-buildable, photo-viral.

### Anti-list (never)

Streaks with loss, confetti storms, badges for logging in, notification re-engagement ("we miss you!"), leaderboards, any delight that fires during an incident, anything the user must dismiss more than once. When in doubt: would it feel right in a cockpit at 2am? Then no.

## 5. Incorporation map (what goes where)

| Item                                              | Graduates to                                                                                          |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Morning briefing + first-morning loop closure     | `09-gtm-plan.md` §2.4 launch-enabling features (added); it is also Script 1's 7am beat                |
| Naming ceremony + recognition-moment polish       | `09` §2.4 via the 5-minute-path item (folded in)                                                      |
| Tier 1 easter eggs (1-7)                          | Launch-polish backlog, Week 4-5; cheap, and HN threads love finding them: seed one hint, never a list |
| Tier 2 (8-14)                                     | Post-launch weeks 4-8; crew numbers land _at_ launch (retroactive numbering is impossible)            |
| Fleet wrapped, lore, hardware light               | Parked here until PMF signal                                                                          |
| Hook-loop language (triggers, investment framing) | Already consistent with `02-positioning.md` §5 pillars; no copy changes needed                        |
| Easter-egg discovery as content                   | `09` Part 5 standing rule: never announce eggs; retweet discoveries                                   |

One planning note: delight is the _last_ coat of paint on each surface, never a substitute for the hardening order (`09` §2.0). A party hat on an agent whose transcript vanishes on restart is the wrong kind of memorable.
