---
title: 'Decision models: fast first-line calls, with frontier models as the escalation'
date: 2026-10-06
type: external-best-practices
status: active
tags:
  [
    decision-models,
    jev,
    system-one,
    moderation,
    spam,
    guard-models,
    llm-as-judge,
    routing,
    escalation,
    audit-trail,
    community-space,
    loop-guard,
  ]
searches_performed: 40
sources_count: 45
---

# Decision models: fast first-line calls, with frontier models as the escalation

Asked for by Dorian on 2026-10-06. Feeds idea 18 of the vision brief (`.temp/vision-202610/10-vision-brief.md`, "Decision models as first-line support"). First users: Community Space moderation and spam (DOR-2764), and the "is this conversation stuck?" judge (DOR-2745).

No earlier report in `research/` covers this. The closest are `20260228_adapter_agent_routing.md` (how a message reaches an agent) and `20260625_hitl_question_routing_async_resume.md` (how a question reaches a person).

## The short version

- **Jev is real.** It is a hosted model from TypeSafe AI, released in early access on 2026-09-15. It answers questions with a label and a confidence number, never with free text. TypeSafe says it takes 70 to 500 milliseconds and costs $0.042 per million input tokens, with output free. TypeSafe's own access is waitlisted, but OpenRouter offers it today with no waitlist.
- **Jev can be fooled, and stay confident while wrong.** An independent paper (JevOut, 2026-09-24) flipped 61% of Jev's correct answers with short, natural-sounding additions to the input. So a decision model is a filter, never a gate that grants anything.
- **"Level 1 thinking" is not a term anyone uses.** The real phrase is **"System One model"**, TypeSafe's own name, borrowed from Kahneman's _Thinking, Fast and Slow_ (System 1 is fast gut calls, System 2 is slow careful thought). "Decision model" is what the explainer articles call it. Both phrases are about three weeks old and come from one company.
- **"Astro" is almost certainly OpenAI's Astra** (often listed as "GPT-6 Astra"), launched 2026-09-03. I found no frontier model named "Astro". **Fable** is Anthropic's Claude Fable 5.1.
- **Jev is not alone.** There are three other families that make the same kind of quick call: safety "guard" models (many free and open), small cheap chat models asked to answer in a fixed format, and specialist routers and judges.
- **There is no shared standard for the answer.** There is a shared _pipe_: most of these speak the OpenAI chat format. Jev does not; it has its own format.
- **Recommendation:** DorkOS adds one small port, `DecisionModel`, with a fixed question shape (choice, score, yes/no) and a fixed answer shape (label, probabilities, confidence, reason). Every use case runs a ladder: free rules first, then the chosen decision model, then a frontier model, then a person or agent with authority. Every rung writes one row to the audit trail.

## 1. What Jev is

**Who makes it.** TypeSafe AI, San Francisco, founded 2024 by Diogo Almeida (formerly at OpenAI), Erik Gafni and Sasha Sheng. It raised a $40M seed round led by DCVC, announced with the launch. ([TypeSafe blog](https://typesafe.ai/blog/introducing-system-one-models-and-jev), [Wikipedia](<https://en.wikipedia.org/wiki/Jev_(AI_model)>))

**What it does.** You send it some input (the "state") and one or more named questions. It returns a typed answer to each question, with probabilities and a confidence score, and then stops. It cannot write sentences. TypeSafe calls it "smart if-statements" and pitches it for classifying, routing, scoring, extracting and branching. ([Zapier](https://zapier.com/blog/jev/), [OpenRouter blog](https://openrouter.ai/blog/insights/what-is-jev/))

**How it works, per TypeSafe.** A "parallel sampler" answers all questions at once instead of writing one word at a time. It is trained with a method TypeSafe calls RLCD (reinforcement learning for calibrated decisions). "Calibrated" means a 90% confidence should be right about 90% of the time. Because it can only pick from your labels, TypeSafe claims a 0% hallucination rate. The architecture is not published, so these are the vendor's own claims. ([TypeSafe blog](https://typesafe.ai/blog/introducing-system-one-models-and-jev), [Wikipedia](<https://en.wikipedia.org/wiki/Jev_(AI_model)>))

**Speed and price.**

|                                 | Jev (TypeSafe's numbers)                                                      |
| ------------------------------- | ----------------------------------------------------------------------------- |
| Time per call                   | 70 to 500 ms end to end                                                       |
| Input price                     | $0.042 per million tokens                                                     |
| Output price                    | free ("too cheap to meter")                                                   |
| Claimed gain vs frontier models | 40x to 200x faster; "193.6x faster, 444.6x cheaper" on its own workflow evals |
| Compared against                | GPT-5.6 Terra, GPT-6 Astra, Fable 5.1                                         |

I found no independent test of Jev's speed. Every number in the table is TypeSafe's own. Two independent papers do test its accuracy, and both are warnings:

- **JevOut** ([arXiv 2609.30243](https://arxiv.org/abs/2609.30243), 2026-09-24): short additions that "fit naturally" into the input redirected 312 of 508 correct decisions (61%). In 229 of those, Jev gave the wrong answer a probability of at least 0.7. Other decision systems flipped 65% to 73% of the time, so this is not only a Jev problem.
- **Type-Safe Is Not Error-Free** ([arXiv 2609.26758](https://arxiv.org/abs/2609.26758), 2026-09-22): a model of Jev's kind follows the _name_ of an option more than the description you attach to it. Renaming two options from "0/1" to "no/yes" changed about 70 answers in every 100. Neutral names (random strings) removed the effect without hurting accuracy.

The lesson for DorkOS: "0% hallucination" only means Jev always picks one of your labels. It does not mean it picks the right one, and a hostile sender can push it.

**The question types.** ([DEV guide](https://dev.to/valyuai/how-to-use-jev-a-practical-guide-to-typesafes-system-one-model-g5e), [DataCamp](https://www.datacamp.com/blog/system-one-models-jev))

- **Choice:** pick one of up to 255 named options. Returns the pick, the probability of each option, and a confidence.
- **Score:** place the input on an ordered scale of 2 to 10 levels. Returns a score (it can fall between levels), the probabilities, and a confidence.
- **Noul:** a yes or no question, answered as a probability from 0 to 1.

**The API.** It is its own format, not the OpenAI chat format. LiteLLM (a popular open-source model gateway) can only pass it through untouched, because there is nothing to translate it into. ([LiteLLM docs](https://docs.litellm.ai/docs/pass_through/typesafe))

```json
POST https://api.typesafe.ai/v1/systemone
{
  "model": "jev-latest",
  "state": "Help! My payouts have been failing for 3 days.",
  "questions": {
    "department": {
      "type": "choice",
      "instructions": "Which team should handle this?",
      "criteria": {
        "billing": "Payments, invoicing, refunds",
        "technical": "Bugs, outages, integrations",
        "sales": "Pricing, upgrades, new accounts"
      }
    }
  }
}
```

The answer comes back under `answers`, one entry per question, plus `usage.input_tokens` for cost tracking. Model ids can be pinned (`jev-1.13.0`) or floating (`jev-latest`). Limits on TypeSafe's own API: 64k tokens for the input plus all questions (32k for the input plus the longest question), 1,200 requests a minute. SDKs exist for Python and Node (`@typesafe-ai/sdk`).

**What I could not confirm.**

- **Licence:** proprietary.
- **Self-hosting:** no source mentions it, so treat Jev as cloud-only. That matters for local-first users: every item Jev judges leaves the computer.
- **Availability:** TypeSafe's own API is early access with a waitlist. **OpenRouter offers Jev now with no waitlist** (`typesafe/jev-1.13`, alias `~typesafe/jev-latest`, endpoint `/api/v1/systemone`, 32,000-token limit per call). ([OpenRouter docs](https://openrouter.ai/docs/guides/community/jev)) Secondary reports say Vercel's AI Gateway and Cloudflare carry it too; I did not confirm those.
- **Input:** text and JSON only. No images.

**The pattern TypeSafe recommends** is the same ladder this report proposes: act on its own above a high confidence, flag for review in the middle, hand off below a low one. ([Zapier](https://zapier.com/blog/jev/))

## 2. The other decision makers

There are four families. They differ most in two things: can you give them your _own_ rules, and can they run on the user's own computer.

### 2a. Guard models (safety classifiers)

Built to flag harmful content. Most have a fixed list of harm types. Two take your own written policy.

| Model                                        | Maker         | Runs where                              | Licence         | Your own policy?          | What it returns                                                                       | Cost                                                                                                                                                                              |
| -------------------------------------------- | ------------- | --------------------------------------- | --------------- | ------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI Moderation (`omni-moderation-latest`) | OpenAI        | hosted only                             | proprietary     | no, fixed harm list       | a yes/no and a 0 to 1 score per harm type; text and images                            | **free** ([OpenAI](https://developers.openai.com/api/docs/guides/moderation))                                                                                                     |
| Mistral Moderation                           | Mistral       | hosted only                             | proprietary     | no                        | a score per harm type                                                                 | free per [Mistral pricing](https://mistral.ai/pricing/api/)                                                                                                                       |
| gpt-oss-safeguard (20B, 120B)                | OpenAI        | **open weights**                        | Apache 2.0      | **yes, its main feature** | a verdict plus its full reasoning                                                     | free weights; you pay for the computer ([OpenAI](https://openai.com/index/introducing-gpt-oss-safeguard/))                                                                        |
| ShieldGemma (2B, 9B, 27B)                    | Google        | open weights                            | Gemma licence   | **yes**, text             | yes/no probability                                                                    | free weights. Note: ShieldGemma **2** (4B) judges images only, against three fixed rules ([HF](https://huggingface.co/google/shieldgemma-2-4b-it))                                |
| Llama Guard 4 (12B)                          | Meta          | open weights                            | Llama 4 licence | no, fixed list            | safe/unsafe plus harm code; text and images                                           | about $0.03 to $0.18 per million tokens hosted ([HF](https://huggingface.co/blog/llama-guard-4))                                                                                  |
| Llama Prompt Guard 2 (22M, 86M)              | Meta          | open weights, tiny                      | Llama licence   | no                        | benign or malicious (prompt injection only)                                           | $0.03 to $0.04 per million tokens on Groq ([Groq](https://console.groq.com/docs/model/llama-prompt-guard-2-86m))                                                                  |
| Qwen3Guard (0.6B, 4B, 8B)                    | Alibaba       | open weights                            | Apache 2.0      | no                        | safe, unsafe or controversial; 119 languages; a streaming version judges word by word | free weights ([MarkTechPost](https://www.marktechpost.com/2025/09/26/meet-qwen3guard-the-qwen3-based-multilingual-safety-guardrail-models-built-for-global-real-time-ai-safety/)) |
| Granite Guardian 3.x (3B, 5B, 8B)            | IBM           | open weights                            | Apache 2.0      | partly                    | label plus score; also checks if an answer is backed by its sources                   | free weights ([IBM](https://research.ibm.com/blog/ibm-granite-guardian-5b-3b))                                                                                                    |
| NemoGuard content safety (8B)                | NVIDIA        | open weights or NVIDIA's hosted service | Llama-derived   | no                        | label plus harm code                                                                  | free weights ([NVIDIA](https://docs.nvidia.com/nim/llama-3-1-nemoguard-8b-contentsafety/latest/index.html))                                                                       |
| Perspective API                              | Google Jigsaw | hosted                                  | free            | no                        | toxicity scores                                                                       | free, but **shuts down 2026-12-31** ([FAQ](https://support.perspectiveapi.com/s/about-the-api-faqs?language=en_US)). Do not build on it.                                          |
| Constitutional classifiers                   | Anthropic     | inside Claude only                      | n/a             | n/a                       | not sold as a product                                                                 | n/a ([Anthropic](https://alignment.anthropic.com/2025/cheap-monitors/))                                                                                                           |

### 2b. Small chat models asked for a fixed answer

Any cheap chat model can act as a decision model if you give it the rules and force a JSON answer. This is the most flexible option and the easiest to swap.

| Model                                                   | Price per million tokens (in / out)                                        | Speaks the OpenAI format?                    |
| ------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------- |
| GPT-5 nano                                              | $0.05 / $0.40 ([OpenAI](https://developers.openai.com/api/docs/pricing))   | yes                                          |
| GPT-5 mini                                              | $0.25 / $2.00 (same source)                                                | yes                                          |
| Claude Haiku 4.5                                        | $1.00 / $5.00                                                              | no, but widely bridged                       |
| Llama 3.1 8B on Groq                                    | from $0.05 input ([Groq](https://console.groq.com/docs/models))            | yes                                          |
| gpt-oss-120B on Groq or Cerebras                        | roughly $0.15 to $0.35 in, $0.60 to $0.75 out (secondary sources disagree) | yes                                          |
| Gemini Flash and Flash-Lite                             | I could not confirm current prices against Google's own page               | yes, through Google's compatibility endpoint |
| Local through Ollama (Qwen3 small, Gemma 3, Phi-4-mini) | $0 per call; needs a capable laptop                                        | yes                                          |

One known weak spot: a chat model's own "I am 90% sure" is often not a real 90%. Getting a trustworthy confidence takes extra work: reading the model's token probabilities (logprobs), or asking a few times and checking agreement. Logprobs and forced JSON answers do not yet combine cleanly on OpenAI's API ([bug report](https://community.openai.com/t/gpt-5-1-5-2-message-output-text-logprobs-is-empty-when-structured-outputs-json-schema-is-enabled-in-responses-api/1371927)). This is the gap Jev claims to fill.

### 2c. Routers and judges

- **Arch-Router (Katanemo, 1.5B, open weights, Katanemo Community License).** Takes your routing rules as input and picks a route; claims 93% accuracy. Commercial use needs a separate licence, so check before shipping it. ([HF](https://huggingface.co/katanemo/Arch-Router-1.5B), [VentureBeat](https://venturebeat.com/technology/new-1-5b-router-model-achieves-93-accuracy-without-costly-retraining))
- **RouteLLM (open source, Apache 2.0).** Picks between a cheap and an expensive model per request. It claims over 85% cost savings while keeping 95% of quality. ([roundup](https://dreaming.press/posts/2026-06-21-routellm-vs-notdiamond-vs-martian.html))
- **NotDiamond.** Hosted model picker. Martian's router looks discontinued. (same source)
- **Judges that grade against your rubric:** Patronus GLIDER (score plus reason), Atla Selene 1 Mini (8B), Prometheus 2. Patronus Lynx checks whether an answer sticks to its sources. ([Patronus](https://docs.patronus.ai/docs/research_and_differentiators/Glider), [Atla](https://huggingface.co/blog/AtlaAI/selene-1-mini))

### 2d. Spam services

Akismet ($9.95 to $49.95 a month), CleanTalk (from $12 a year) and OOPSpam ($23 a month for 25,000 checks). They return spam or not spam, with no confidence and no reason. ([OOPSpam comparison](https://www.oopspam.com/compare/akismet-vs-cleantalk)) They are built for blog comment forms, not chat between members who signed in. For the Community Space, a decision model with our own rules fits better.

### 2e. Cost per 1,000 decisions

To compare like with like, assume each decision reads **500 tokens** (rules plus the item) and writes **50**. Real costs move with message length.

| Option                                          | Cost per 1,000 decisions                        | Speed                                          | Your own rules | Runs offline             |
| ----------------------------------------------- | ----------------------------------------------- | ---------------------------------------------- | -------------- | ------------------------ |
| Free rules in code (repeat checks, rate checks) | $0                                              | under 1 ms                                     | yes, as code   | yes                      |
| OpenAI or Mistral moderation                    | $0                                              | fast (not published)                           | no             | no                       |
| Local model through Ollama                      | $0 (electricity)                                | depends on the laptop                          | yes            | **yes**                  |
| Jev                                             | about **$0.02**                                 | 70 to 500 ms (claimed)                         | yes            | no                       |
| Llama Guard on a hosted service                 | about $0.02 to $0.10                            | fast                                           | no             | no (or yes, self-hosted) |
| GPT-5 nano                                      | about $0.05                                     | not published                                  | yes            | no                       |
| Claude Haiku 4.5                                | about $0.75                                     | about 0.3 to 0.5 s to first word (third-party) | yes            | no                       |
| GPT-6 Astra (a frontier model)                  | about **$7.50**, more once it reasons at length | seconds                                        | yes            | no                       |

Astra's price is $10 in and $50 out per million tokens, rising to $20 and $75 for inputs over 272,000 tokens ([OpenAI pricing](https://developers.openai.com/api/docs/pricing), where it is listed as `gpt-6-astra`). Fable 5.1 sits in the same frontier class; check Anthropic's current price list before quoting a figure. The point holds either way: **a frontier call costs a few hundred times what a first-line call costs.** That gap is why the ladder pays for itself.

## 3. Is there a common interface?

Partly. The pieces line up like this:

- **Input** is almost always the same three things: **rules** (a policy, rubric or list of labels with descriptions), the **item** to judge, and some **context** (who sent it, what came before).
- **Output** usually has some of: a **label**, **probabilities** per label, a **confidence**, and a **reason**. Jev returns the first three. gpt-oss-safeguard returns a label and a long reason. OpenAI Moderation returns a score per fixed harm type.
- **The pipe is mostly shared:** Groq, Cerebras, Together, Fireworks, Ollama, vLLM and NVIDIA's service all speak the OpenAI chat format. So one DorkOS bridge reaches all of them.
- **The answer shape is not shared.** No standards body defines it. Every vendor has its own.
- **Jev is the exception on the pipe:** its own endpoint, its own format.

So DorkOS should own the shape. Defining our own small question and answer types, then writing one bridge per family, costs little. It also keeps the choice of model in the user's hands, not ours.

## 4. Fable and Astra

- **Fable 5.1** is Anthropic's Claude frontier model (model id `claude-fable-5-1`). DorkOS users already reach Claude through Claude Code.
- **Astra** is OpenAI's most capable model, launched 2026-09-03, aimed at using computers and browsers and at security and coding work. It drew criticism because its reasoning is harder to inspect. Third-party listings call it "GPT-6 Astra". ([TechCrunch](https://techcrunch.com/2026/09/03/openai-launches-astra-its-powerful-and-controversial-new-model/), [OpenRouter](https://openrouter.ai/openai/gpt-6-astra))
- I found **no frontier model named "Astro"**. The only other hit was an unrelated spacecraft model.

## 5. Design for DorkOS

### 5a. The idea in one picture

```
an event happens (a post, an email, a stuck-looking chat)
   │
   ▼
Rung 0: free rules in code ──── clear answer? ── act, record
   │ not clear
   ▼
Rung 1: decision model (user's pick) ── confident? ── act, record
   │ unsure
   ▼
Rung 2: frontier model (Fable, Astra...) ── confident? ── act, record
   │ still unsure, or the action is serious
   ▼
Rung 3: a person or agent with authority ── decides, record
```

Each rung is optional per use case. The loop judge, for example, already has its rung 0 settled: three free checks, and two must fire before any model runs (vision brief, idea 3).

### 5b. The port

A fifth swappable seam, beside `AgentRuntime`, `Transport`, `ConnectorProvider` and `CommunityAdapter`. It lives in `packages/shared/src/decision-model.ts` and copies Jev's three question types, because they cover every use case below and every other family can be bent to fit them.

```ts
/** One question to answer about one item. */
type DecisionQuestion =
  | { kind: 'choice'; instructions: string; labels: Record<string, string> } // label -> description
  | { kind: 'score'; instructions: string; levels: string[] } // 2..10, lowest first
  | { kind: 'yesno'; instructions: string; yes?: string; no?: string };

interface DecisionRequest {
  useCase: string; // 'community.spam', 'loop.stuck', ...
  policyVersion: string; // hash of the rules text, for the audit row
  item: string | Record<string, unknown>; // the thing being judged
  context?: string | Record<string, unknown>; // sender, recent history
  questions: Record<string, DecisionQuestion>;
}

interface DecisionAnswer {
  value: string | number | boolean;
  probabilities?: Record<string, number>;
  confidence: number; // 0..1; see "calibration" below
  reason?: string; // only from models that can write one
}

interface DecisionResult {
  answers: Record<string, DecisionAnswer>;
  modelId: string; // pinned version, e.g. 'typesafe/jev-1.13.0'
  latencyMs: number;
  costMicroUsd?: number;
}

interface DecisionModel {
  readonly id: string;
  readonly capabilities: {
    kinds: Array<'choice' | 'score' | 'yesno'>;
    customRules: boolean; // false for fixed-list moderation APIs
    reasons: boolean;
    calibrated: boolean; // true only where the vendor shows evidence, or our own evals do
    runsLocally: boolean; // nothing leaves the computer
    maxInputTokens: number;
  };
  decide(req: DecisionRequest, signal: AbortSignal): Promise<DecisionResult>;
}
```

**Bridges to build, in order:**

1. **Rules** (built in, free, offline). Plain TypeScript checks: the loop guard's repeat, no-work and speed checks; rate and link-count checks for spam. It answers with confidence 1 or 0.
2. **OpenAI-compatible chat**, with a forced JSON answer. One bridge covers Ollama (local), Groq, Cerebras, GPT-5 nano and mini, gpt-oss-safeguard, ShieldGemma and Llama Guard served through vLLM, and any OpenRouter chat model. It gets confidence from logprobs where the server offers them. Otherwise it asks twice and lowers confidence when the two answers disagree.
3. **Jev**, through its System One endpoint, reached through OpenRouter today (or TypeSafe directly later). Its yes/no type returns a probability but no confidence, so the bridge derives one: the distance of the probability from 0.5, doubled.
4. **Moderation APIs** (OpenAI, Mistral). Fixed harm list only, so only `choice` questions whose labels map onto that list.
5. **Frontier**, used only as rung 2. It reuses bridge 2 for OpenAI-format models. For Claude it calls Anthropic's API with the user's own key, or DorkOS credits (ADR `261001-000811`). It never uses a Claude Code sign-in: the vision brief's open risk on Anthropic's terms says DorkOS must not carry a Claude login.

**Conformance.** Like runtimes, every bridge passes a shared `decisionModelConformance` suite: shape of answers, timeouts, refusal on unknown labels, no network for `runsLocally`.

**Failure is just "unsure".** A timeout, an outage, a refusal or an answer with a label we did not ask for all count as confidence 0. The use case's "when unsure" default then applies. A bridge that fails several times in a row is skipped for a few minutes (a circuit breaker), so a dead service never slows the room down.

**Where the code lives.** The types go in `packages/shared/src/decision-model.ts`, which holds schemas and types only. The bridges, which make network calls, go in a new `packages/decisions`, so both the DorkOS server and the community app can import them.

### 5c. The ladder and the thresholds

Each use case declares a small policy:

```ts
interface DecisionPolicy {
  useCase: string;
  rules: string; // the plain-words policy text the model reads
  questions: Record<string, DecisionQuestion>;
  actAbove: number; // e.g. 0.95: act without anyone looking
  escalateBelow: number; // e.g. 0.70: go up one rung
  whenUnsure: 'allow' | 'hold'; // what happens once every rung is unsure
  serious: string[]; // labels that always go to rung 3, however confident
  dailyCallCap: { rung1: number; rung2: number }; // past this, behave as unsure
}
```

Three principles set the numbers:

- **The cost of being wrong is lopsided, so the default is too.** The loop judge's mistake costs a stalled conversation that runs for days, so when unsure it lets the agents keep going (the brief says so). A spam judge's mistake costs a member's post vanishing, so when unsure it hides nothing and asks a moderator.
- **Confidence must be earned.** Only trust a bridge's confidence once our own test set shows it means what it says. Until then, treat every rung-1 answer as "unsure" and run in watch-only mode.
- **Spending has a ceiling.** A spam flood, or posts written to look borderline on purpose, would push many items up to the expensive rung. Each use case has a daily call cap per rung. Past it, the ladder stops calling models and applies the "when unsure" default, and the owner is told once.
- **Serious actions skip the ladder.** Removing a member, or anything that cannot be undone, always reaches a person or agent with authority. That matches the access-level design (idea 4 of the brief).

### 5d. Watch-only first, then measure

Every use case ships in **watch-only mode**: the decision is made and recorded, but nothing happens. The brief already asks this of the loop judge. While watching:

- Rung 2 (or a person) judges a sample of the same items. The agreement rate becomes the case for turning rung 1 on.
- Every time a person overrules a decision, that pair (item, right answer) joins the use case's test set. The audit trail becomes the eval set for free.
- We flip to live only when rung 1 agrees with the reference at least as often as rung 2 agrees with a person.

### 5e. Recording every decision

One row per rung, as a `decision.*` event in the audit trail that `09-audit-trail.md` designs. It holds:

- use case, rung, model id (pinned version), policy version (a hash of the rules text);
- what was judged, as a link to the post or message (not a copy), plus a hash of the exact input;
- the answers, confidence and reason;
- what happened next: acted, held, escalated, overruled, and by whom;
- time taken and cost.

That lets anyone in the space answer "why did my post get hidden?" with a link to the row. It also lets anyone replay an old decision against a new model.

**Private sources stay private.** The audit trail is readable by the whole space, but a person's DMs, their direct chats with agents, and their email are not (brief, idea 3). For decisions about those, the row keeps only the use case, the outcome and a hash. No reason text and no link a stranger could follow.

**Decision rows are not work.** The loop guard's "no work" check reads the audit trail. It must ignore `decision.*` rows, or every judge call would make a stuck conversation look busy.

Three rules keep this safe under trust-by-default:

- **A decision model can only narrow, never widen.** It can hide, hold, pause, tag, or suggest. It can never grant power, unlock a tool, or skip a notice the brief requires. So a stranger who tricks the model gets nothing a stranger would not already get (the brief's outsider rule). A conformance test pins this: no decision result can reach a permission or tool check.
- **Assume the item is hostile.** The JevOut paper shows short, natural-looking text can flip a decision with high confidence. So the item travels in its own field, never pasted into the rules, and nothing irreversible happens on a model's word alone. For chat bridges, a tiny Prompt Guard check (about $0.03 per million tokens) can run first on outsider content.
- **Use neutral label names, and test them.** Since models of Jev's kind follow option names over descriptions, label names are short neutral codes, and each use case's test set includes the same items under renamed labels.

### 5f. Choosing a model, per use case

A user sees one setting per use case, in plain words: "Quick checks use: Built-in rules only / This computer (Ollama) / Jev / An OpenAI-compatible service / DorkOS credits". Plus "Hard cases go to:" a frontier model they already pay for, or "Ask me".

Defaults:

- **Local-first user, no keys:** built-in rules, with hard cases going to a person. If Ollama is running with a small model, offer it.
- **A key is not a choice.** Having an OpenAI, Groq or OpenRouter key set does not switch on paid calls. Rung 1 stays "built-in rules" until a person picks a paid model in this setting. This follows the repo's money rule (AGENTS.md: "a key alone arms nothing"), and a paid bridge joins the money-path table there when it ships.
- **The DorkOS Community Space** (run by us, on the community server): OpenAI Moderation (free) for clear harm, plus Jev or gpt-oss-safeguard with our own written rules for spam and off-topic. Rung 2 is a frontier model; rung 3 is the space's moderators, people or agents.

Privacy note for the picker: say plainly which choices send the item off the computer. Only "built-in rules" and "this computer" keep it local.

### 5g. Where it runs

The decision service sits in `apps/server/src/services/decisions/` as a new service domain. The Community Space is the exception: it is a separate program (`apps/community`), so it imports the port and the bridges from the shared package and runs its own ladder there. The rules text for each use case lives as a plain markdown file, versioned, so people and agents can read and propose changes to it.

## 6. Use cases

Each row names its question type and its "when unsure" default.

| #   | Use case                                                                                                                                                                                                                   | Question                                            | When unsure                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------- |
| 1   | **Community spam** (DOR-2764): is this new post spam, self-promotion, or fine?                                                                                                                                             | choice                                              | show the post, ask a moderator                                  |
| 2   | **Community moderation**: does this break the space's rules, and which rule?                                                                                                                                               | choice                                              | show, ask a moderator                                           |
| 3   | **New-member check**: does this sign-up look like a bot?                                                                                                                                                                   | score                                               | let them in, watch the first posts                              |
| 4   | **Stuck conversation** (DOR-2745): spinning, waiting on something real, or working?                                                                                                                                        | choice                                              | let the agents keep going                                       |
| 5   | **Who should answer**: which agent in the room fits this message best? A suggestion only; anyone can still answer                                                                                                          | choice (labels = agents' role and responsibilities) | ask in the room who wants it                                    |
| 6   | **Incoming email triage**: urgent, needs reply, read later, newsletter, or junk?                                                                                                                                           | choice                                              | keep it in the inbox                                            |
| 7   | **Outsider message tagging**: is this stranger on Telegram, Slack or a webhook asking a question, reporting a bug, selling something, or other? A tag for whoever reads it; it never decides what an agent may do for them | choice                                              | tag "other"                                                     |
| 8   | **Notice or not**, only for actions the brief does not already require a notice for (outside actions always notify): does this need everyone to know now, or is the audit row enough?                                      | yesno                                               | notify                                                          |
| 9   | **Notification priority**: interrupt now, batch for later, or just log?                                                                                                                                                    | score                                               | batch for later                                                 |
| 10  | **"Build me…" intent**: is this a request for a mini app, a one-off answer, or a task?                                                                                                                                     | choice                                              | ask the person one question                                     |
| 11  | **Task tagging**: which project, which labels, how big?                                                                                                                                                                    | choice + score                                      | leave untagged                                                  |
| 12  | **Health-check rules**: is this agent idle, blocked, or fine? Does this group's goal read as real?                                                                                                                         | choice                                              | report "can't tell" in the check                                |
| 13  | **Duplicate finder**: is this new task or bug the same as an open one?                                                                                                                                                     | yesno                                               | keep both, link as "maybe related"                              |
| 14  | **Feedback triage**: bug, feature request, question, or praise; and how angry?                                                                                                                                             | choice + score                                      | send to a person (user-care's one-day reply rule still applies) |
| 15  | **Prompt-injection screen** on outsider content before an agent reads it                                                                                                                                                   | yesno (Prompt Guard)                                | mark as "from a stranger", read with care                       |
| 16  | **Marketplace listing check**: does this public plugin's description match what it contains, or look like a scam?                                                                                                          | choice                                              | hold the listing for review                                     |
| 17  | **Publishing abuse check**: does a free public page look like phishing? (brief, idea 10 and open risks)                                                                                                                    | choice                                              | keep it link-only until reviewed                                |
| 18  | **Secret spotting**: does this message seem to contain a password or key that should go in the vault instead?                                                                                                              | yesno                                               | warn the sender, post anyway                                    |
| 19  | **Model picker** (RouteLLM-style): can a cheaper model handle this agent turn? Only ever offered as a choice the person turns on                                                                                           | yesno                                               | use the agent's normal model                                    |
| 20  | **Room summary trigger**: has this thread grown long enough and settled enough to summarise?                                                                                                                               | yesno                                               | do nothing                                                      |

## 7. What to build first

1. **The port and the rules bridge**, with the loop judge's three free checks as its first user. Nothing to buy, works offline, and it unblocks DOR-2745's watch-only mode.
2. **The OpenAI-compatible bridge and the Jev bridge**, side by side. The first covers Ollama, Groq, GPT-5 nano and gpt-oss-safeguard in one go; the second reaches Jev through OpenRouter today. Use them as rung 1 for the loop judge (only after two of three checks fire) and for Community spam.
3. **The `decision.*` audit rows**, landing with the audit trail work (trust step 2). No use case goes live before its decisions are recorded.
4. **Community spam and moderation** (DOR-2764) in watch-only mode during the two-week soft launch. Run Jev and one OpenAI-format model on the same posts, and keep whichever wins on agreement and cost. That gives us real posts to measure against before the public launch.

## Open questions

- **Jev for local-first users.** It is cloud-only, so it can never be the default for a user who keeps everything on their computer.
- **Vendor risk.** TypeSafe is a young company three weeks into early access. The port makes Jev replaceable, which is the main defence.
- **Accuracy under attack.** Two independent papers already show Jev's answers can be pushed by hostile text. Nobody outside TypeSafe has tested its calibration on normal traffic. Our own watch-only data is that test.
- **Arch-Router's licence** blocks commercial use as written. Do not ship it without checking.

## Sources

- [TypeSafe: Introducing System One Models and Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
- [Wikipedia: Jev (AI model)](<https://en.wikipedia.org/wiki/Jev_(AI_model)>)
- [DEV Community: How to use Jev](https://dev.to/valyuai/how-to-use-jev-a-practical-guide-to-typesafes-system-one-model-g5e)
- [DataCamp: Jev explained](https://www.datacamp.com/blog/system-one-models-jev)
- [OpenRouter: Jev guide](https://openrouter.ai/docs/guides/community/jev)
- [JevOut: Natural Context Can Flip Decision Models (arXiv 2609.30243)](https://arxiv.org/abs/2609.30243)
- [Type-Safe Is Not Error-Free (arXiv 2609.26758)](https://arxiv.org/abs/2609.26758)
- [LiteLLM: TypeSafe pass-through](https://docs.litellm.ai/docs/pass_through/typesafe)
- [Zapier: What is Jev?](https://zapier.com/blog/jev/)
- [OpenRouter: What is Jev?](https://openrouter.ai/blog/insights/what-is-jev/)
- [Correlation One: what is an AI decision model](https://www.correlation-one.com/blog/what-is-an-ai-decision-model-jev-system-one-models-and-when-to-use-one-instead-of-an-llm-2026)
- [MarkTechPost: TypeSafe releases Jev](https://www.marktechpost.com/2026/09/19/typesafe-ai-releases-jev/)
- [TechCrunch: OpenAI launches Astra](https://techcrunch.com/2026/09/03/openai-launches-astra-its-powerful-and-controversial-new-model/)
- [OpenRouter: GPT-6 Astra](https://openrouter.ai/openai/gpt-6-astra)
- [OpenAI moderation guide](https://developers.openai.com/api/docs/guides/moderation) and [pricing](https://developers.openai.com/api/docs/pricing)
- [OpenAI: gpt-oss-safeguard](https://openai.com/index/introducing-gpt-oss-safeguard/)
- [Mistral pricing](https://mistral.ai/pricing/api/)
- [Hugging Face: Llama Guard 4](https://huggingface.co/blog/llama-guard-4) and [Meta model card](https://www.llama.com/docs/model-cards-and-prompt-formats/llama-guard-4/)
- [OpenRouter: Llama Guard 3 8B](https://openrouter.ai/meta-llama/llama-guard-3-8b)
- [Groq: Prompt Guard 2](https://console.groq.com/docs/model/llama-prompt-guard-2-86m) and [models](https://console.groq.com/docs/models)
- [ShieldGemma 2 on Hugging Face](https://huggingface.co/google/shieldgemma-2-4b-it)
- [IBM: Granite Guardian 5B and 3B](https://research.ibm.com/blog/ibm-granite-guardian-5b-3b)
- [NVIDIA NemoGuard content safety](https://docs.nvidia.com/nim/llama-3-1-nemoguard-8b-contentsafety/latest/index.html)
- [MarkTechPost: Qwen3Guard](https://www.marktechpost.com/2025/09/26/meet-qwen3guard-the-qwen3-based-multilingual-safety-guardrail-models-built-for-global-real-time-ai-safety/)
- [Perspective API FAQ](https://support.perspectiveapi.com/s/about-the-api-faqs?language=en_US)
- [Anthropic: cheap monitors](https://alignment.anthropic.com/2025/cheap-monitors/)
- [Arch-Router model card](https://huggingface.co/katanemo/Arch-Router-1.5B) and [VentureBeat](https://venturebeat.com/technology/new-1-5b-router-model-achieves-93-accuracy-without-costly-retraining)
- [RouteLLM vs NotDiamond vs Martian](https://dreaming.press/posts/2026-06-21-routellm-vs-notdiamond-vs-martian.html)
- [Patronus GLIDER and Lynx](https://docs.patronus.ai/docs/research_and_differentiators/Glider)
- [Atla Selene 1 Mini](https://huggingface.co/blog/AtlaAI/selene-1-mini)
- [OOPSpam: Akismet vs CleanTalk](https://www.oopspam.com/compare/akismet-vs-cleantalk)
- [OpenAI community: logprobs empty with structured outputs](https://community.openai.com/t/gpt-5-1-5-2-message-output-text-logprobs-is-empty-when-structured-outputs-json-schema-is-enabled-in-responses-api/1371927)
- [structured-logprobs project](https://github.com/arena-ai/structured-logprobs)
