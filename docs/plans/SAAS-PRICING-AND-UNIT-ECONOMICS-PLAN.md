# GuardianAgent SaaS Pricing and Unit Economics Plan

**Status:** Draft  
**Date:** 2026-03-28  
**Primary context:** [GuardianAgent Multi-Tenant SaaS Platform - Detailed Design](/mnt/s/Development/GuardianAgent/docs/proposals/MULTI-TENANT-SAAS-AGENT-PLATFORM-DETAILED-DESIGN.md)

## Objective

Turn the current rough hosted-SaaS estimate into a launchable pricing strategy, unit-economics model, and validation plan.

This document defines:

- the working cost model
- recommended launch plans
- target gross margins
- quota and overage posture
- the measurement work required before pricing is committed publicly

This document does not define:

- final public website copy
- enterprise contract pricing
- finance-approved long-range forecasts

## Pricing Strategy

- Sell a hosted workspace and agent product, not raw token access.
- Keep the default experience on the cheapest reliable lane: shared local and open models.
- Treat premium managed-cloud and frontier models as metered scarce resources.
- Support bring-your-own keys, but do not let BYO remove platform charges for compute, browser, storage, or support.
- Prefer a short trial over a permanent free tier in v1.
- Make `workspace` the billable unit in v1. Add seats and team packaging later.

## Working Assumptions

All figures below are working inputs for a first-pass model:

- region: `us-east-1`
- currency: USD
- product shape: hosted web UI plus Telegram first
- v1 excludes hosted raw shell, SSH, and general workstation access
- one global control plane and one regional workload cell at launch
- shared local inference pools absorb most routine chat volume
- Bedrock is available for managed-cloud usage
- customer BYO keys are supported and metered separately from platform-paid model spend
- "active paid user" means a paying workspace that generates meaningful monthly usage
- shared-overhead math becomes healthier around `500` to `1,000` active paid users
- all cloud and model prices must be refreshed before launch approval

## Unit Economics Model

Use this as the planning formula:

```text
Monthly COGS per active paid user =
  shared platform overhead allocation
  + included model spend
  + execution compute
  + browser compute
  + storage and logging
  + auth, payment, support, and fraud reserve
```

### 1. Shared platform overhead

Working envelope for the first real production footprint:

- control plane
- one workload cell
- PostgreSQL
- Redis
- queues
- object storage
- observability
- security services
- baseline redundancy and headroom

Planning range:

- `$2,000` to `$5,000` per month total

Allocated overhead per active paid user:

| Active paid users | Overhead per user |
| --- | --- |
| `250` | `$8` to `$20` |
| `500` | `$4` to `$10` |
| `1,000` | `$2` to `$5` |

### 2. Shared local-model lane

Use the shared GPU pool to absorb most chat traffic and protect margin.

Working planning inputs from the current estimate:

- `g6.2xlarge`: about `$714` per month
- `g6e.2xlarge`: about `$1,637` per month

At roughly `300` moderately active users per lane:

- `g6.2xlarge`: about `$2.4` per user
- `g6e.2xlarge`: about `$5.5` per user

Practical planning envelope:

- `$2` to `$6` per active paid user

Key risk:

- underutilized or overprovisioned GPU lanes destroy margin quickly
- redundancy doubles cost if the second lane sits mostly idle

### 3. Managed-cloud model lane

Use Bedrock for controlled upgrades, not as the default lane for the entire product.

Illustrative Bedrock reference points from the 2026-03-28 estimate:

- `Qwen3 32B`: about `$0.0773 / 1M` input tokens and `$0.3090 / 1M` output tokens
- `Claude 3.5 Sonnet`: about `$6 / 1M` input tokens and `$30 / 1M` output tokens

Illustrative monthly user examples:

- cheap open model, `1M` input plus `250k` output:
  - about `$0.15`
- Sonnet-class model, `1M` input plus `250k` output:
  - about `$13.50`
- Sonnet-class model, `3M` input plus `750k` output:
  - about `$40.50`

Pricing implication:

- cheap managed-cloud open models can be bundled
- Sonnet-class and frontier usage must be capped, credit-based, or overage-metered

### 4. Browser, worker, storage, and ops overhead

Working planning envelope for non-model variable cost:

- execution workers: `$0.50` to `$2` per active user
- browser workers: `$0.50` to `$4` per active user
- storage, logs, screenshots, and traces: `$0.50` to `$2` per active user
- auth, payment processing, support, and fraud reserve: `$1` to `$3` per active user

Practical combined planning envelope:

- `$2.5` to `$11` per active paid user

The upper end appears quickly if the product becomes browser-heavy or support-heavy.

## Working COGS Envelopes

Use these as planning ranges until real beta telemetry replaces them:

| Plan shape | Expected usage posture | Working COGS |
| --- | --- | --- |
| Local and open first self-serve | mostly shared local models, light browser, modest automations | `$4` to `$10` |
| Pro mixed lane | local and open default, some Bedrock or premium usage, more browser and concurrency | `$8` to `$18` |
| Premium assisted automation | higher automation volume, more browser, meaningful premium model usage | `$20` to `$50+` |

These are costs, not selling prices.

## Recommended Launch Packaging

### 1. `self-serve`

Recommended positioning:

- one personal workspace
- one default agent
- hosted web UI and Telegram
- shared local and open models included
- BYO keys allowed
- limited browser and automation quotas
- no large included Sonnet or frontier allowance

Recommended launch price:

- `$29 / month`

Target cost and margin:

- target COGS: `<= $8`
- acceptable COGS ceiling: about `$10`
- target gross margin: `70%+`

Recommended caps:

- small browser minute pool
- low concurrency
- low connector count
- hard cap on included premium model spend
- optional paid top-ups for premium model credits and browser minutes

### 2. `pro`

Recommended positioning:

- heavier daily use
- more automations and higher concurrency
- more browser minutes
- small included premium-model allowance
- better admin and reporting later

Recommended launch price:

- `$79 / month`

Target cost and margin:

- target COGS: `<= $18`
- target gross margin: `75%+`

Recommended caps:

- moderate browser minute pool
- moderate automation count
- moderate concurrency
- limited included premium-model credits
- paid overage once included premium spend is exhausted

### 3. `premium`

Recommended positioning:

- power users
- heavier automation
- more browser work
- faster queues
- meaningful but still bounded premium-model allowance
- priority support or premium support SLA later

Recommended launch price:

- `$149 / month` base
- premium-model and browser overage beyond the included envelope

Target cost and margin:

- target COGS: `<= $50`
- target gross margin: `60%+`

Recommended caps:

- generous but still metered browser minutes
- higher concurrency
- higher connector limits
- explicit monthly premium-model spend budget
- hard stop or approval flow after budget exhaustion

### 4. `enterprise / dedicated`

Do not put this on a fixed public price list in v1.

Recommended posture:

- custom pricing
- dedicated cell or private deployment option
- optional BYO cloud account and BYO models
- contractual storage, retention, and support terms

## Packaging Rules That Protect Margin

- Do not make Sonnet-class or frontier models the default for every chat.
- Do not promise unlimited browser automation on low-cost plans.
- Do not offer an open-ended free tier at launch.
- Do not treat BYO keys as a substitute for browser, storage, and execution pricing.
- Do offer top-ups or overages for premium models and browser minutes.
- Do keep most ordinary chat on the local and open lane unless policy or quality requires escalation.
- Do use hard caps, not only soft warnings, for the most expensive resources.

## What The Estimate Still Needs To Measure

The current ranges are directionally useful, but launch pricing should not be locked until the platform measures:

- monthly active paid users per GPU lane
- median and p95 prompt and completion token volumes by lane
- premium-model escalation rate
- average browser minutes per active user
- worker runtime per successful run
- storage and log growth per workspace
- Telegram and connector abuse rate
- support minutes per paying workspace
- failed run retry rate
- trial conversion and fraud rate

## Required Metering Before Public Launch

The product needs a usage ledger that records, per workspace:

- input tokens
- output tokens
- model provider and model class
- browser minutes
- execution minutes
- storage bytes
- artifact counts
- connector actions
- automation runs
- support or manual intervention flags where relevant

Without this ledger, pricing will drift away from actual cost and the product will misprice heavy users.

## Validation Plan

### Phase 0: Instrumentation

Ship first:

- workspace-scoped usage ledger
- model gateway cost attribution
- GPU pool occupancy and queue telemetry
- browser session duration metrics
- per-workspace storage and trace growth
- billing-ready plan cap enforcement

Exit criteria:

- every expensive resource is meterable per workspace
- monthly COGS can be reconstructed from internal telemetry

### Phase 1: Private beta measurement

Run a beta with at least `20` to `50` real users or design partners.

Track:

- light, standard, and heavy user cohorts
- lane mix between local, Bedrock, BYO, and premium
- browser usage distribution
- support burden
- abuse and fraud events

Exit criteria:

- `30` days of usable COGS history
- percentile-based usage envelopes for each plan
- evidence that at least `80%` of users fit cleanly inside one of the launch plans

### Phase 2: Launch pricing lock

Before public launch:

- finalize retail pricing
- finalize included quotas
- define overage rules
- wire billing UI and usage dashboard
- write abuse and fair-use policy
- add auto-upgrade and hard-stop behavior

Exit criteria:

- every plan has positive margin at p50 usage
- premium plan is still profitable at expected p80 usage
- fraud and abuse controls are live

### Phase 3: Post-launch optimization

After launch:

- reduce prompt size and completion length where possible
- route more volume to local and open models
- move premium models behind smarter escalation logic
- trim browser trace retention
- right-size GPU pools and cell headroom
- consider reserved capacity or savings plans once the usage baseline stabilizes

Exit criteria:

- measured COGS per active paid user trends downward
- margin becomes predictable enough for annual pricing and enterprise packaging

## Easy-To-Miss Costs

These usually get underestimated:

- payment processor fees
- refunds, chargebacks, and card-testing abuse
- Google and Microsoft app verification and compliance work
- support time for connector auth failures
- noisy browser traces and screenshots in storage
- prompt inflation from tool results and browser transcripts
- idle redundancy in GPU pools
- incident response and break-glass support access
- sales tax or VAT handling if the product expands internationally

## Recommended Decisions Now

- Build for three launch plans: `self-serve`, `pro`, and `premium`.
- Price the platform as a workspace subscription, not a token bundle.
- Make shared local and open inference the default included lane.
- Keep premium models quota-bound and budget-aware.
- Use a trial instead of a permanent free tier.
- Do not promise hosted CLI or SSH in v1.
- Implement billing-grade metering before public launch.

## Success Criteria

- the team can explain COGS per active paid user from telemetry instead of guesswork
- each public plan has a clear usage envelope and gross-margin target
- premium-model usage is bounded well enough that power users do not erase margin
- the pricing model leaves room for enterprise dedicated tiers without reworking the product
- retail pricing can be revised later without changing the platform billing model

## Sources

- GuardianAgent Multi-Tenant SaaS Platform - Detailed Design: [local design doc](/mnt/s/Development/GuardianAgent/docs/proposals/MULTI-TENANT-SAAS-AGENT-PLATFORM-DETAILED-DESIGN.md)
- Amazon Bedrock pricing: <https://aws.amazon.com/bedrock/pricing/>
- Amazon Cognito pricing: <https://aws.amazon.com/cognito/pricing/>
- AWS Fargate pricing: <https://aws.amazon.com/fargate/pricing/>
- AWS Aurora pricing: <https://aws.amazon.com/rds/aurora/pricing/>
- AWS CloudWatch pricing: <https://aws.amazon.com/cloudwatch/pricing/>
- AWS KMS pricing: <https://aws.amazon.com/kms/pricing/>
- AWS price list API docs: <https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/using-the-aws-price-list-bulk-api-fetching-price-list-files-manually.html>
- Public AWS price-list mirrors used as working GPU placeholders:
  - `g6.2xlarge`: <https://www.economize.cloud/resources/aws/pricing/ec2/g6.2xlarge/>
  - `g6e.2xlarge`: <https://www.economize.cloud/resources/aws/pricing/ec2/g6e.2xlarge/>
