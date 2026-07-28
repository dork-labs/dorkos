---
title: 'Messaging etiquette as source material for agent chat behavior (North Star)'
date: 2026-07-27
type: external-best-practices
status: active
tags:
  [
    conversation-analysis,
    turn-taking,
    grice,
    politeness,
    cmc,
    chat-etiquette,
    human-agent-interaction,
    rooms,
  ]
feature_slug: room-participation
searches_performed: 16
sources_count: 38
---

# Messaging etiquette: the body of knowledge behind "good chat manners"

Research question: what do conversation analysis, computer-mediated-communication (CMC) research, professional chat etiquette, and human-agent interaction research actually establish about group conversation norms, and how does that convert into testable rules for an AI agent in DorkOS rooms, channels, and DMs?

---

## Research Summary

Four bodies of work carry real weight here. Conversation analysis (Sacks/Schegloff/Jefferson) gives a mechanical model of who may speak when, and its rules translate almost directly into agent speaking rights. Grice gives a compact quality bar for the content of a turn, and there is a recent adaptation of it specifically for human-AI dialogue that adds benevolence and transparency. CMC research establishes that text chat systematically breaks the CA machinery (disrupted adjacency, no simultaneous feedback), which means agents must do explicit repair work that speakers get for free in speech. Human-agent research from 2023 to 2026 converges on one finding worth treating as a default: moderate, selective participation beats both constant participation and near-silence, and the failure mode users complain about most is agent dominance, not agent under-contribution.

The research is thin or contested in three places: whether agents should ever simulate typing delays (evidence points both ways and is mostly from customer-service chatbots, not colleague-agents), whether one long message beats several short ones (professional etiquette says one, one CHI experiment on casual chatbots says several), and almost nothing exists on agent-to-agent etiquette observed by humans, which is exactly the DorkOS case.

---

## Strand 1: Conversation analysis and linguistics

### 1.1 The turn-taking system (Sacks, Schegloff & Jefferson 1974)

"A Simplest Systematics for the Organization of Turn-Taking for Conversation," _Language_ 50(4): 696-735. The model has two components plus a rule set.

**Turn-constructional component.** A turn is built from unit-types: sentential, clausal, phrasal, and lexical. Each unit type projects its own completion, so participants can anticipate where it ends. "The first possible completion of a first such unit constitutes an initial transition-relevance place" (TRP). ([Max Planck Institute record](https://www.mpi.nl/publications/item2376846/simplest-systematics-organization-turn-taking-conversation), [Semantic Scholar](https://www.semanticscholar.org/paper/A-simplest-systematics-for-the-organization-of-for-Sacks-Schegloff/88811ee8953981c26bf23c8d335474eae121ab91))

**Turn-allocation component: the rules, applying at each TRP.**

- **Rule 1(a)**: "If the turn-so-far is so constructed as to involve the use of a 'current speaker selects next' technique, then the party so selected has the right and is obliged to take next turn to speak; no others have such rights or obligation, and transfer occurs at that place."
- **Rule 1(b)**: If no next speaker is selected, "self-selection for next speakership may, but need not, be instituted; first starter acquires rights to a turn, and transfer occurs at that place."
- **Rule 1(c)**: If no next speaker is selected and no one self-selects, "current speaker may, but need not continue," unless another self-selects.
- **Rule 2**: If neither 1(a) nor 1(b) has operated and the current speaker has continued under 1(c), the rule set re-applies at the next TRP, and recursively at each next TRP, until transfer is effected.
  ([turn-taking rules text](http://turn-taking.blogspot.com/2010/08/turn-taking-rules.html), [TRP definition, emcawiki](<https://emcawiki.net/Transition-relevance_place_(TRP)>))

**Design consequences of the system.** SSJ observe that the system is "locally managed, party-administered, interactionally controlled": turn size and turn order are not pre-allocated, they are negotiated turn by turn. Empirically the system produces overwhelmingly one-party-at-a-time talk with brief overlaps and short gaps. Overlap is treated as a resolvable trouble, not a normal state, and there is machinery for resolving it (one party drops out, usually the later starter, and often recycles the overlapped portion).

**Why this matters for agents.** Rule 1(a) is the strongest constraint we can codify: explicit addressing (an @mention, a named question) confers both a right and an obligation on exactly one party, and explicitly removes that right from everyone else. An agent that answers a question addressed to a human is not merely eager, it is violating the single most robust rule in the system. Rule 1(b) covers the unaddressed question: self-selection is permitted and "first starter acquires rights," which is precisely the case where an always-fast agent will systematically outrun every human and monopolize the floor.

### 1.2 Repair (Schegloff, Jefferson & Sacks 1977)

"The Preference for Self-Correction in the Organization of Repair in Conversation," _Language_ 53(2): 361-382. There is an organization of repair addressed to recurrent problems in speaking, hearing, and understanding. Two structural preferences hold: **self-repair is preferred over other-repair**, and **self-initiation is preferred over other-initiation**. The argument rests on both frequency and sequential position: repair opportunities are ordered so that the trouble-source speaker gets first chance to fix it, and other-correction, when it happens, is typically modulated (hedged, framed as uncertain) or is a vehicle for something else. ([Semantic Scholar](https://www.semanticscholar.org/paper/The-preference-for-self-correction-in-the-of-repair-Schegloff-Jefferson/191a416ea8d6673a7c2ceecc3b36e2b118430ccd), [emcawiki: self-repair](https://emcawiki.net/Self-repair), [SciRP reference](https://www.scirp.org/reference/referencespapers?referenceid=1093297))

For agents: correcting a human's factual error is other-initiated other-repair, the most dispreferred cell in the matrix. The etiquette-compliant move is to create the conditions for self-repair (an other-initiation such as a clarifying question), or to correct with mitigation, and to reserve blunt correction for cases where the cost of the error is high and immediate.

### 1.3 Adjacency pairs and preference organization

Adjacency pairs are two-part sequences produced by different speakers, adjacently positioned, and typed: question/answer, greeting/greeting, offer/acceptance-or-refusal, complaint/apology. Given a first pair part, the second is _conditionally relevant_: its absence is noticeable and accountable, not merely absent.

Preference organization: preferred seconds are structurally simple, immediate, and unmarked. Dispreferred seconds are "marked by various kinds of complexity, including delays, prefaces and accounts," plus hesitation, mitigation, qualification, appreciation, and apology. "A delay is an item used to put off a dispreferred second part." Blunt, unmitigated declines "can be seen as rude or hostile," so extra conversational work is required to perform them. ([Conversation Analysis lecture notes, Sharif](https://sharifling.wordpress.com/wp-content/uploads/2015/09/lect-07_conversation-analysis.pdf), [Discourse Analysis notes, UCG](https://www.ucg.ac.me/skladiste/blog_4089/objava_31330/fajlovi/2%20Discourse%20Analysis%20_%20Conversation%20Analysis.pdf), [adjacency pair, emcawiki](https://emcawiki.net/Adjacency_pair), [Dispreferred, ResearchGate](https://www.researchgate.net/publication/377694911_Dispreferred))

Closing sequences: conversations are not simply stopped, they are closed collaboratively, via pre-closings ("okay," "alright then") that offer the other party a chance to reopen, followed by terminal exchanges. An agent that stops replying mid-sequence leaves a first pair part hanging, which reads as rudeness or malfunction.

Backchannels: minimal responses ("mhm," "right") that signal continued attention without claiming a turn. Their text-chat analogues are emoji reactions and short acknowledgments, which are cheap because they do not consume floor.

### 1.4 Grice's maxims (1975) and their chat application

The Cooperative Principle with four maxims: **quantity** (as informative as required, no more), **quality** (do not say what you believe false or lack evidence for), **relation** (be relevant), **manner** (avoid obscurity and ambiguity, be brief and orderly). ([Effectiviology summary](https://effectiviology.com/principles-of-effective-communication/))

Applied to chatbots, quantity/quality/manner violations measurably reduce perceived humanness and quality of a conversational agent ([Impact of the Gricean Maxims of Quality, Quantity and Manner in Chatbots](https://www.researchgate.net/publication/335499957_The_Impact_of_the_Gricean_Maxims_of_Quality_Quantity_and_Manner_in_Chatbots)).

**The most useful modern adaptation** is Miehling et al., "Language Models in Dialogue: Conversational Maxims for Human-AI Interactions" ([arXiv:2403.15115](https://arxiv.org/abs/2403.15115)). They retain quantity, quality, relevance, and manner, and add two maxims specific to machine interlocutors:

- **Benevolence**: govern the generation of, and engagement with, harmful content.
- **Transparency**: acknowledge knowledge boundaries, operational constraints, and intents.

Transparency is directly load-bearing for a chat agent: saying what it can see, what it cannot, and what it is about to do.

### 1.5 Politeness theory (Brown & Levinson 1987)

Built on Goffman's "face." Every participant has **positive face** (the desire to be approved of, liked, included) and **negative face** (the desire for autonomy, freedom from imposition). Face-threatening acts (FTAs) run against these wants: criticism, correction, and disagreement threaten positive face; requests, orders, and interruptions threaten negative face.

Four strategies, ordered by increasing mitigation:

1. **Bald on-record**: no mitigation. Appropriate when urgency is high, the relationship is close, or the face risk is low.
2. **Positive politeness**: attend to the hearer's positive face (agreement, common ground, inclusion, compliments).
3. **Negative politeness**: minimize imposition (hedges, apologies, indirectness, giving options, "if you have time").
4. **Off-record**: hint rather than state.

Strategy choice is driven by weight of the FTA, computed from social distance, relative power, and the culturally-rated imposition of the act. ([Politeness theory overview, Grokipedia](https://grokipedia.com/page/Politeness_theory), [Vaia summary](https://www.vaia.com/en-us/explanations/english/pragmatics/politeness-theory/), [bald on record](https://studybay.com/blog/the-bald-on-record-strategy/))

Agent-relevant reading: an agent's default should be light negative politeness for anything that imposes (asking for permission, requesting clarification, proposing work) and positive politeness for disagreement (acknowledge the point before departing from it), with bald on-record reserved for genuine urgency (data loss, security, a destructive command about to run). Notably, the emergency carve-out is native to the theory, so "be blunt when the building is on fire" is not an exception to politeness, it is part of it.

---

## Strand 2: Computer-mediated communication research

### 2.1 Text chat breaks the CA machinery (Herring 1999)

Susan Herring, "Interactional Coherence in CMC," _JCMC_ 4(4). ([Oxford Academic full text](https://academic.oup.com/jcmc/article/4/4/JCMC444/4584407))

Two structural causes of incoherence:

- **Lack of simultaneous feedback.** Text CMC is one-way during composition: "it is technically impossible for the addressee to respond while the message is being written." There is no backchannel during a turn, so no mid-turn course correction, and TRPs are invisible.
- **Disrupted turn adjacency.** Messages "are posted in the order received by the system, without regard for what they are responding to." One documented extreme case: a response separated from its initiation by 50 messages.

Quantitative findings:

- 47% of turns in a social chat channel were off-topic relative to the turn they responded to (Herring & Nix).
- In three topically coherent IRC samples, 33% violated the Gricean maxim of local relevance.
- 18% of messages in #yakyak (n=226) received no response at all.
- In three asynchronous listserv discussions, 34% of participants (n=117) who posted received no response.
- In a topical discussion list, on-topic messages fell from 65% to 33% within nine days (topic decay).

User adaptations, which are the coherence-repair toolkit that agents should adopt deliberately:

1. **Addressivity**: prefacing a turn with the recipient's name or @handle.
2. **Linking**: explicitly referring to the content of the prior message.
3. **Quoting**: copying part of a prior message to create "the illusion of adjacency."
4. **Backchannels**: minimal responses signaling engagement.

Herring also notes the paradox: loosened coherence has upsides (heightened interactivity, multiple simultaneous threads, play), which is why chat survives despite incoherence. This is an argument against over-policing conversational tidiness.

### 2.2 Chronemics: silence and latency carry meaning

Kalman & Rafaeli, "Online Pauses and Silence: Chronemic Expectancy Violations in Written CMC," _Communication Research_ 38(1), 2011 ([SAGE](https://journals.sagepub.com/doi/10.1177/0093650210378229)); Kalman et al., "Pauses and Response Latencies: A Chronemic Analysis of Asynchronous CMC," _JCMC_ 12(1), 2006 ([Oxford Academic](https://academic.oup.com/jcmc/article/12/1/1/4582956)); Kalman, Scissors, Gill & Gergle, "Online chronemics convey social information," _Computers in Human Behavior_, 2013 ([PDF](https://collablab.northwestern.edu/lscissors/Kalman%20Scissors%20Gill%20&%20Gergle%202013.pdf)).

Key results: across three datasets totaling more than 150,000 responses (corporate email, student discussion groups, a commercial answer market), response latencies follow a power-law distribution in which at least 70% of responses are created quickly. This establishes a **norm**, which in turn makes deviation an **expectancy violation** carrying social meaning. Silence is not neutral, it is read. Faster responses improve perceived credibility and attractiveness of the sender in business contexts.

For agents this cuts both ways: an agent that goes quiet during long work is emitting a signal it did not intend, which is the empirical basis for "acknowledge before a long silence."

### 2.3 Typing indicators and read receipts as social signals

- CHI 2023, "'Together but not together': Evaluating Typing Indicators for Interaction-Rich Communication" ([ACM](https://dl.acm.org/doi/10.1145/3544548.3581248), [PDF](https://jeffhuang.com/papers/LiveTyping_CHI23.pdf)). Richer typing indicators increased perceived co-presence and were perceived as communicatively rich, but restricting asynchrony "can heighten a user's perceived co-presence but at the cost of making them feel overwhelmed and obliged to communicate."
- Read receipts, "last seen," and online status "transform what was once invisible processing time into a publicly observed silence," creating response-time pressure, obsessive checking, and anxiety when a message is read but unanswered.

Design read: presence signals are not free. A persistent "agent is typing" for minutes at a time converts the agent's compute time into social pressure on humans.

### 2.4 Interruption cost

The widely cited figure is roughly 23 minutes to fully return to a task after an interruption (Mark et al. lineage), with knowledge workers switching tasks every few minutes. The number is repeated far more often than it is replicated, so treat it as directional rather than precise. What is solid: notification interruptions measurably increase strain and degrade performance, and the cost rises with task complexity ([Effects of task interruptions caused by notifications, PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC10244611/)). Every avoidable agent message in a channel is an interruption charged against a human's attention budget.

---

## Strand 3: Practical and professional etiquette guidance

### 3.1 Slack's own guidance

[Collaborate with kindness: etiquette tips in Slack](https://slack.com/blog/collaboration/etiquette-tips-in-slack), [Tips on threaded messages](https://slack.com/resources/using-slack/tips-on-how-best-to-use-threaded-messages), [Notify a channel or workspace](https://slack.com/help/articles/202009646-Notify-a-channel-or-workspace).

- **Channels by default, DMs by exception.** Post in channels; reserve @username mentions for specific requests or urgent matters.
- **Threads for follow-ups.** Threads let members ask for clarification "without tripping the unread indicator for everyone else in the channel." When a decision or deadline change emerges in a thread, use "Also send to #channel" so non-followers see it.
- **@mention discipline.** Mention someone when you need a response from them or are discussing work they own. "@channel, @here, and @everyone" should be used sparingly: "It's courteous to refrain from notifying large groups of people if it's not truly necessary."
- **One message, not many.** "Getting everything you need into a single direct message means that only one notification is sent... Multiple messages means multiple interruptions."

### 3.2 Widely repeated team-chat norms (practitioner consensus, not research)

From LeadDev, remote-team handbooks, and the "don't say just hello" genre ([LeadDev guide to Slack etiquette](https://leaddev.com/communication/leaddev-guide-slack-etiquette), [MOSTLY AI handbook](https://mostly.ai/handbook/mostly-ai-employee-handbook/communication/slack-etiquette), [nohello-style guidance](https://getculturebot.com/blog/slack-etiquette-tips-for-remote-teams/)):

- Never send a bare "hi" or "hey" as its own message: it costs a notification and buys nothing. Put the question in the first message.
- Do not fragment one thought across five messages.
- Async is the default: do not expect or demand an instant reply.
- Prefer public over private, so the answer is reusable.
- Edit rather than post a correction message, when the correction is minor and recent.
- Use reactions instead of "thanks!" messages when acknowledgment is all that is needed.
- Give the context in the first message: what you want, by when, and what happens if it does not arrive.

These are conventions rather than findings, but their convergence across independent sources is itself evidence about expectations agents will be judged against.

---

## Strand 4: Human-agent interaction in group settings

### 4.1 Over-participation is the dominant complaint

**Controlling AI Agent Participation in Group Conversations: A Human-Centered Approach**, IUI 2025, IBM Research ([arXiv:2501.17258](https://arxiv.org/abs/2501.17258), [ACM](https://dl.acm.org/doi/10.1145/3708359.3712089)). Two mixed-methods studies of small groups brainstorming in Slack. Participants benefited from and preferred having the agent present, but "disliked when the agent seemed to dominate the conversation" and wanted controls over its behavior. Contributions were sometimes "overwhelming" and "distorted their discussion." The output is a taxonomy of controls along five dimensions: **when** the agent responds, **what** it responds about, **where** it responds, **who** can control it, and **how** controls are specified.

That five-dimension taxonomy maps cleanly onto product surface: a per-room policy for when/what/where, plus who can change it.

### 4.2 Moderate proactivity beats both extremes

**Proactive Conversational Agents with Inner Thoughts**, CHI 2025 ([arXiv:2501.00383](https://arxiv.org/html/2501.00383v2), [ACM](https://dl.acm.org/doi/full/10.1145/3706598.3713760)). The core claim: next-speaker prediction is insufficient in multi-party settings, because self-selection moments are driven by covert internal motivation rather than observable cues. The agent forms candidate "thoughts" continuously and speaks only when intrinsic motivation crosses a threshold, scored 1-5 on relevance, information gap, expected impact, urgency, coherence, originality, balance, and dynamics.

Results:

- Technical evaluation over 100 simulated conversations: outperformed the next-speaker-prediction baseline on all seven metrics, strongest on turn appropriateness (p = 2.4e-6) and coherence (p = 1.6e-5), with an 82% preference rate.
- User study (6 pairs, 3 conditions): the "non-stop chatter" agent was the most easily identified as AI (69%) and rated least favorably; the highly selective agent was identified only 55% of the time but was criticized as "too passive"; the moderate "active contributor" achieved the best balance across likeability and engagement.

Read: **constant participation reads as mechanical, near-total silence reads as disengaged.** The tunable is a motivation threshold, and the eight scoring dimensions are a usable rubric for our own "should I speak" gate.

### 4.3 Timing and context sensitivity

**Read the Room: Exploring When LLM Agents Should Participate in Everyday Mixed-Context Group Chats**, CHI 2026 Extended Abstracts ([ACM](https://dl.acm.org/doi/10.1145/3772363.3798392)). Six dyads of acquaintances in a ChatGPT group chat, each pair doing both casual conversation and travel planning, with an LLM bot (SeeSawBot) participating proactively. Findings: agents should be designed for **when to stay silent** as much as when to speak; response length and follow-up depth should adapt per conversation segment; agents should avoid intruding during **active opinion exchange**, especially in casual talk. Critically, **ill-timed participation in casual talk carried over and biased perceptions of later proactive participation**: one badly timed interjection poisons subsequent, otherwise-useful ones.

**ProACT: Towards Breakdown-Aware Proactive Agent in Multi-User Collaboration**, 2026 ([arXiv:2607.03730](https://arxiv.org/pdf/2607.03730)). Frames proactivity as a decision to remain silent or intervene, with the goal of repairing an emerging collaboration breakdown "while avoiding unnecessary interruption when participants are already making progress." Targeted interventions improved task completion and information sharing; unnecessary interruptions degraded user experience and perceived helpfulness. The design principle: intervene on **breakdown**, not on **opportunity**.

**To Err is AI: Imperfect Interventions and Repair in a Conversational Agent Facilitating Group Chat Discussions**, CSCW 2023 ([ACM](https://dl.acm.org/doi/10.1145/3579532)). Relevant because it treats agent error as a repairable social event rather than a system fault: a facilitator agent that makes a mistake and repairs it can retain acceptability.

### 4.4 Verbosity and sycophancy

- **YapBench** ([arXiv:2601.00624](https://arxiv.org/pdf/2601.00624)) measures chatbot over-communication and names the recurring categories of superfluous content: unsolicited suggestions, unrequested follow-up questions, recaps and restatements, and hedging/disclaimers. It quantifies the problem rather than prescribing a target length.
- Verbosity bias is baked into preference-trained models: longer outputs are systematically favored by both human and LLM raters even when quality is equal ([Saito et al., arXiv:2310.10076](https://arxiv.org/pdf/2310.10076)). Reported observations include roughly 77% of ChatGPT answers being verbose, and mean output length growing ~2.5x across DPO iterations. Treat specific numbers as indicative.
- Users prefer short answers for simple tasks, and lower cognitive load correlates with more positive attitudes and stronger continued-use intent.
- Sycophancy degrades outcomes: a within-subjects study with 24 students found a high-sycophancy chatbot produced less improvement in users' mental models, and 71% of users reported detecting no difference between sycophancy levels ([Invisible Saboteurs, arXiv:2510.03667](https://arxiv.org/pdf/2510.03667)). Users cannot self-report their way out of this; the fix has to be in defaults. Related: [Challenging the Evaluator: LLM Sycophancy Under User Rebuttal](https://arxiv.org/html/2509.16533), and reporting that professional framing reduces sycophancy ([Northeastern](https://news.northeastern.edu/2026/02/23/llm-sycophancy-ai-chatbots/)).

### 4.5 Simulated typing delays: contested

- Chatbots with static or dynamic response delays were perceived as more human-like and higher in social presence than near-instant responders ([The Chatbot is typing..., ResearchGate](https://www.researchgate.net/publication/328744481_The_Chatbot_is_typing_-_The_Role_of_Typing_Indicators_in_Human-Chatbot_Interaction)).
- But in customer service, longer latency **reduced** satisfaction, with a typing indicator partially mitigating the damage ([From Seconds to Sentiments, IJHCI 2025](https://www.tandfonline.com/doi/full/10.1080/10447318.2025.2508915)).
- Effects are moderated by prior experience: experienced users penalize delay, novices reward it ([Opposing Effects of Response Time in Human-Chatbot Interaction](https://www.researchgate.net/publication/360950385_Opposing_Effects_of_Response_Time_in_Human-Chatbot_Interaction_The_Moderating_Role_of_Prior_Experience)).
- Latency above roughly 4 seconds degrades quality of experience; fillers help most under high delay ([Mitigating Response Delays, arXiv:2507.22352](https://arxiv.org/pdf/2507.22352)).

Synthesis: **artificial** delay is not supported for an expert-operator audience (Kai and Priya are exactly the "prior experience" group that penalizes it). Honest signaling of **real** latency is supported. That is a meaningful distinction: show a typing/working indicator when actually working, never pad.

---

## Strand 5: Cross-cultural and accessibility considerations

**Cross-cultural.** Hall's high-context / low-context distinction predicts that identical directness reads as efficient to one reader and rude to another; high-context cultures (Japan, China, Korea, India, much of the Middle East and Latin America) rely more on implication, low-context cultures state things explicitly ([Talaera](https://www.talaera.com/culture/high-vs-low-context-cultures/), [EBSCO research starter](https://www.ebsco.com/research-starters/communication-and-mass-media/high-context-and-low-context-cultures)). Emoji do politeness work and are culturally variable: the same glyph can read as prayer, gratitude, or namaste; a smiley may signal decorum rather than delight in Japanese usage and face-saving in Chinese usage; misreads can flip friendly into sarcastic ([Digitally saving face, ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S0378216621003350), [cultural differences in emoticon/emoji use, NSF](https://par.nsf.gov/servlets/purl/10341758), [Studying Cultural Differences in Emoji Usage](https://www.researchgate.net/publication/332182691_Studying_Cultural_Differences_in_Emoji_Usage_across_the_East_and_the_West)). Practical rule for agents: be explicit rather than hinting (low-context default is safer in writing, since implication does not survive translation), and keep emoji functional and sparse.

**Accessibility.** Screen readers announce emoji alt text inline, so emoji mid-sentence break the reading flow; guidance is to place emoji at the end, avoid runs of them (a common cap is 3), and never substitute an emoji for a word ([BOIA](https://www.boia.org/blog/emojis-and-web-accessibility-best-practices), [CUNY accessibility toolkit](https://guides.cuny.edu/accessibility/memeEmoji), [UX Content Collective](https://uxcontent.com/accessible-content-design-for-emojis/)). For chat interfaces specifically, the screen reader must identify the sender, read incoming messages, and orient the user to the input ([GOV.UK: patterns for accessible webchats](https://accessibility.blog.gov.uk/2016/12/09/patterns-for-accessible-webchats/), [Penn State chat accessibility](https://accessibility.psu.edu/software/chat)). Message fragmentation is an accessibility problem, not just an etiquette one: five bubbles are five screen-reader announcements. ASCII art, box-drawing tables, and decorative separators are hostile to screen readers, which matters for an agent that likes to dump formatted output.

---

## Synthesized principles: a candidate etiquette rule set

Each rule is written so a reviewer can hold a transcript against it and judge pass/fail. Basis is cited in brackets.

### A. Speaking rights (who may speak, when)

1. **Do not answer a question that was explicitly addressed to another participant unless invited.** If @alice is asked, the agent stays out until alice responds, defers, or the asker re-addresses. _Basis: SSJ Rule 1(a): the selected party has the right and obligation, and "no others have such rights."_ _Test: find a turn addressed to a named party; the agent's next message must not be the answer._

2. **When explicitly addressed, respond, or explicitly decline: never leave a first pair part unanswered.** Silence after a direct question is accountable, not neutral. _Basis: SSJ Rule 1(a) obligation; conditional relevance of adjacency pairs; Kalman on silence as expectancy violation._ _Test: every @mention of the agent has a corresponding agent turn, or a logged reason._

3. **On an unaddressed question, yield before self-selecting.** Where a human could plausibly answer, wait a defined beat before speaking; if a human has begun (typing indicator, or has answered), do not post a competing answer. _Basis: SSJ Rule 1(b) "first starter acquires rights," combined with the fact that an agent will always win a race; Herring on lack of simultaneous feedback._ _Test: agent answers to unaddressed questions in a room with active humans should be a minority of its turns, and never within the yield window._

4. **Speak only when the contribution passes a motivation threshold, not whenever a reply is possible.** Score candidate contributions on relevance, information gap, expected impact, urgency, coherence, originality, and conversational balance; post only above threshold. _Basis: Inner Thoughts (CHI 2025): moderate proactivity beat both non-stop chatter (least liked, most obviously robotic) and maximal selectivity (rated "too passive")._ _Test: no more than one unprompted agent turn per N human turns in a room; sample unprompted turns and check each names the gap it filled._

5. **Do not interject during an active exchange between humans.** Wait for a lull or a direct invitation, especially during opinion exchange or debate. _Basis: Read the Room (CHI 2026): avoid intrusion during active opinion exchange, and ill-timed interjections bias perception of all later ones._ _Test: no agent turn inserted between two human turns separated by less than the lull window, absent an @mention._

6. **Intervene on breakdown, not on opportunity.** Unprompted contributions are for stuck, contradictory, missing-information, or about-to-be-costly situations, not for every place the agent knows something. _Basis: ProACT: targeted breakdown interventions helped; unnecessary ones degraded experience._ _Test: for each unprompted turn, name the breakdown it repaired._

### B. Shape of a turn

7. **Prefer one message over three.** One coherent turn per contribution; do not serialize a single thought across bubbles. _Basis: Slack: "Multiple messages means multiple interruptions"; accessibility (each message is a separate screen-reader announcement)._ _Test: count consecutive agent messages with no intervening human turn; more than one needs justification._ _Contested: one CHI'22 EA study of casual NLG chatbots found five candidate replies improved experience, but that was a candidate-selection design for a social bot, not a colleague agent._

8. **Match message length to the question.** A yes/no question gets a sentence, not a section-headed report. Long output goes behind a link, a file, a thread, or an explicit "want the detail?" offer. _Basis: Grice quantity; YapBench categories of superfluous content; verbosity bias in preference-trained models; users prefer short answers for simple tasks._ _Test: median agent message length in a room; flag any message over N lines that was not requested._

9. **Cut the four filler categories: unsolicited suggestions, unrequested follow-up questions, recaps of what was just said, and hedging boilerplate.** _Basis: YapBench taxonomy; Grice manner and quantity._ _Test: scan agent turns for closing "would you like me to..." and opening restatements; each occurrence needs a reason._

10. **No bare greetings, no content-free acknowledgments as separate messages.** Use a reaction or fold the acknowledgment into the substantive message. _Basis: no-hello convention; Slack notification economy; backchannels in CA are cheap precisely because they do not take the floor._ _Test: zero agent messages whose entire content is a greeting, "thanks," "got it," or "sure!"._

11. **Anchor every reply to what it responds to.** Use addressivity (@name), quoting, or a thread reply so the message survives disrupted adjacency. _Basis: Herring: messages post in arrival order regardless of what they answer, with responses separated from initiations by up to 50 messages; users repair via addressivity, linking, quoting._ _Test: in a multi-party room, each agent turn is either a thread reply or names its referent._

12. **Reply in the thread the question was asked in; escalate to channel only for decisions and changes that affect everyone.** _Basis: Slack threading guidance, including "Also send to #channel" for decisions._ _Test: agent channel-level posts should be announcements or decisions, not Q&A follow-ups._

### C. Timing and presence

13. **Acknowledge before a long silence, then report on completion.** If work will exceed the room's response norm, post a short "on it, will report back" and nothing else until there is a result. _Basis: Kalman: at least 70% of responses in natural corpora are fast, so latency beyond norm is an expectancy violation carrying meaning; adjacency-pair conditional relevance._ _Test: any gap between an agent-accepted request and its result that exceeds the threshold must contain exactly one acknowledgment._

14. **Signal working status honestly; never simulate typing or pad latency.** Show a working indicator when actually working; answer at full speed when the answer is ready. _Basis: contested literature on delay (human-likeness gains vs satisfaction losses), moderated by user experience level, with experienced users penalizing delay; CHI 2023 on presence signals producing felt obligation._ _Test: no artificial delay in code; indicator lifetime equals real work duration._

15. **Do not @here / @channel, and do not @mention a human unless a response is required from them specifically.** Broadcast pings are for things people would want to be woken for. _Basis: Slack's own guidance on sparing use; interruption cost literature._ _Test: count agent broadcast mentions; the expected number is zero outside a defined urgency class._

16. **Batch related notices into one turn rather than emitting one per event.** Three finished tasks are one message. _Basis: Slack notification economy; interruption cost._ _Test: agent turns per unit time during bursty work._

### D. Disagreement, correction, and refusal

17. **Correct with mitigation, and prefer prompting self-repair over direct correction.** Ask the clarifying question that lets the human find their own error; correct outright only when the cost of the error is high or immediate. _Basis: Schegloff/Jefferson/Sacks 1977: strong structural preference for self-repair and self-initiation; other-correction is dispreferred and normally modulated._ _Test: sample agent corrections of humans; each should either be hedged, be framed as a question, or carry a stated high-cost justification._

18. **Disagree substantively rather than agreeing to please, and do not reverse a correct position under social pressure.** Acknowledge the point (positive politeness), then state the disagreement and the evidence. _Basis: Brown & Levinson positive politeness for FTAs; sycophancy research showing worse user mental models with high-sycophancy agents, and reversal under user rebuttal; users cannot detect sycophancy in themselves (71% reported no difference)._ _Test: seed a transcript where a human asserts something false and pushes back once; the agent must hold its position._

19. **Decline like a colleague: brief reason, plus an alternative where one exists.** No lecture, no apology spiral. _Basis: preference organization: dispreferred seconds require accounts and mitigation, but a bald unmitigated decline reads as hostile; Brown & Levinson negative politeness._ _Test: each refusal contains a reason and, where possible, one alternative, and stays within a couple of sentences._

20. **Be blunt when it is urgent.** For data loss, security, or an irreversible action about to happen, drop the hedging and say the thing plainly and first. _Basis: bald on-record is the correct strategy under urgency in Brown & Levinson, not a violation of politeness._ _Test: in a seeded destructive-action transcript, the warning is the first clause of the first message._

### E. Honesty and legibility

21. **State knowledge boundaries and operating constraints without being asked.** Say what was not checked, what is stale, and what the agent cannot see. _Basis: Miehling et al. transparency maxim; Grice quality._ _Test: any answer resting on an unverified assumption names it._

22. **Never present an inference as an observation.** Distinguish "I ran it and it passed" from "it should pass." _Basis: Grice quality (do not assert what you lack adequate evidence for); repo convention on verified claims._ _Test: grep agent claims for verb tense and hedges against actual tool calls in the transcript._

23. **Repair your own errors promptly and visibly, in the same place they occurred.** _Basis: self-repair preference; To Err is AI (CSCW 2023): agent errors are recoverable social events when repaired._ _Test: after a corrected error, the correction appears in the same thread and references the wrong claim._

### F. Room hygiene and formatting

24. **Format for a reader, not for a terminal.** No dumped raw logs, no ASCII tables, no wall of tool output; summarize and link to the artifact. _Basis: Grice manner; accessibility guidance for screen readers; wall-of-text aversion._ _Test: agent messages contain no raw multi-hundred-line output blocks._

25. **Keep emoji functional, sparse, at the end, and never load-bearing.** Reactions are fine for acknowledgment; never let an emoji carry the meaning of a sentence. _Basis: screen-reader alt-text behavior and the 3-in-a-row cap; cross-cultural emoji misinterpretation._ _Test: emoji count per message, position, and no message whose meaning depends on one._

26. **Be explicit rather than allusive; do not rely on implication or irony.** _Basis: high-context/low-context differences in written cross-cultural communication; Grice manner (avoid ambiguity)._ _Test: no agent turn whose intended meaning is the opposite of its literal meaning._

27. **Close sequences rather than trailing off.** When a task is done, say it is done and what changed; do not let a request sequence expire without a second pair part. _Basis: closing sequences in CA; conditional relevance._ _Test: every accepted request in a transcript has a terminating agent turn._

**Suggested per-room configurability (not a rule, a product note).** The IUI 2025 taxonomy argues that _when, what, where, who, and how_ should all be controllable by the group, not fixed by the vendor. A sensible default: rooms carry a participation policy (silent / on-mention-only / active contributor), humans in the room can change it, and the agent states its current mode when it joins.

---

## Research Gaps and Limitations

- **Agent-to-agent etiquette with humans watching.** No literature found on norms for multiple AI agents conversing in a channel a human reads. This is the central DorkOS case and we are extrapolating from human multi-party norms.
- **No validated numeric thresholds.** Nothing in the literature gives a defensible number for yield windows, acknowledgment deadlines, or messages-per-hour. Every threshold above must be set by our own dogfooding.
- **Small samples in the HAI work.** Inner Thoughts' user study had 6 pairs; Read the Room had 6 dyads; the sycophancy study had 24 students. Directionally useful, not decisive.
- **Casual-social bias.** Most group-agent studies use casual chat, brainstorming, or travel planning. Engineering-operations chat with a working agent (our case) is materially different: interruptions may be more welcome when they concern the user's own running work.
- **The 23-minute interruption figure** is widely quoted and thinly replicated. Use as directional only.
- **Backchannel equivalents in chat** (reactions) are under-studied as agent behavior. Whether an agent reacting with an emoji reads as attentive or creepy is not established.

## Contradictions and Disputes

1. **One message vs several.** Slack and professional etiquette say consolidate. Chen (CHI '22 EA) found five simultaneous replies improved chatting experience for an NLG social chatbot, because users pick the good reply and ignore the bad. The contexts differ enough that we should follow the Slack norm for a colleague-agent and treat the CHI finding as evidence for offering options within one message.
2. **Simulated delay.** Human-likeness research supports short delays plus typing indicators; customer-service research finds latency reduces satisfaction, mitigated but not erased by the indicator; the moderator is user experience level, and our users are the experienced group. We recommend honest signaling and no padding, but this is a judgment call on top of genuinely mixed evidence.
3. **Selective vs active.** Inner Thoughts found the most selective agent was criticized as "too passive," while IUI 2025 found dominance was the main complaint. These are reconcilable (both point at a middle), but they set the tuning direction differently depending on the room, which supports making participation mode configurable rather than fixed.
4. **Coherence policing.** Herring argues loosened coherence has genuine benefits (interactivity, parallel threads, play). Over-optimizing an agent for tidy threading could make rooms feel bureaucratic.

## Search Methodology

- Searches performed: 16 (plus 10 page fetches).
- Most productive terms: "Sacks Schegloff Jefferson turn allocation rules," "Herring interactional coherence CMC," "when should LLM agent stay silent group chat," "Slack etiquette @channel threads," "chatbot response delay typing indicator social presence," "conversational maxims human-AI."
- Primary sources: Oxford Academic (JCMC), ACM DL (CHI, IUI, CSCW), arXiv, SAGE, slack.com, emcawiki.
- Access failures: Wiley (HTTP 402) for the Herring 1999 mirror, resolved via Oxford Academic; ACM DL 403 for the Read the Room full text, resolved via search snippets; several arXiv PDFs returned unparseable binary and were resolved via abstract pages or search results.
