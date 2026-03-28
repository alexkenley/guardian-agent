# Proposal: Private-By-Default Cloud Deployment Model for GuardianAgent

## Executive Summary

GuardianAgent should treat AWS as the primary deployment target for cloud-hosted installs, with Cloudflare used as an optional access and edge layer rather than the primary runtime.

The recommended deployment shape is:

- one GuardianAgent runtime per user, household, or organization tenant
- one stateful Linux host per runtime by default
- local Ollama on the same host for the simplest secure install, or a private GPU host in the same VPC for larger model workloads
- no direct public exposure of GuardianAgent or Ollama
- remote browser access only through a private front door such as Cloudflare Tunnel + Access or a VPN
- Telegram and web/browsing tools handled through outbound internet access only

This recommendation is driven by the current architecture, not generic cloud preference. GuardianAgent today is a long-running, stateful Node.js process with local PTY sessions, in-memory web session state, SSE clients, subprocess-backed tools, and SQLite-backed persistence. That is a strong fit for EC2 and a poor fit for Cloudflare Workers or similar edge/serverless runtimes.

As of March 27, 2026, Cloudflare remains highly attractive for identity-gated private ingress, DNS, and edge policy. It is not the best primary compute substrate for the full GuardianAgent product shape. AWS remains the better deployment base.

## Current Architecture Reality

GuardianAgent's current runtime has several important deployment implications:

- The default web channel binds to `localhost`, not a public interface. See [src/config/types.ts](../../src/config/types.ts).
- The default Ollama provider points to `http://127.0.0.1:11434`, which strongly suggests same-host local-model operation as the baseline. See [src/config/types.ts](../../src/config/types.ts).
- The web layer stores SSE clients, cookie sessions, and PTY terminal sessions in process memory. See [src/channels/web.ts](../../src/channels/web.ts).
- The code surface launches local PTYs with `node-pty`, which requires a traditional host runtime. See [src/channels/web.ts](../../src/channels/web.ts).
- Conversation state, analytics, and code sessions use SQLite-backed persistence. See [src/runtime/conversation.ts](../../src/runtime/conversation.ts), [src/runtime/analytics.ts](../../src/runtime/analytics.ts), and [src/runtime/code-sessions.ts](../../src/runtime/code-sessions.ts).
- The built-in provider registry supports Ollama and several external providers today, but not AWS Bedrock as a first-party provider. See [src/llm/provider-registry.ts](../../src/llm/provider-registry.ts).
- The runtime already recognizes that bearer-only web auth is not the final enterprise story; provider-backed identity is proposed future work. See [docs/proposals/ZEROTRUSTAGENT-UPLIFTS-PROPOSAL.md](./ZEROTRUSTAGENT-UPLIFTS-PROPOSAL.md).

These facts make the immediate deployment conclusion straightforward:

- GuardianAgent is currently best deployed as a single stateful runtime per tenant
- horizontal scaling is not the primary deployment path today
- "edge-first" or "stateless serverless" packaging would require architecture changes first

## Evaluation Criteria

The recommended cloud deployment should:

- keep the origin private by default
- support outbound internet access for Telegram, browsing, web tools, and optional external LLMs
- support local Ollama with enough GPU memory to be useful
- preserve Linux subprocess, PTY, and filesystem semantics
- minimize operator burden for remote administration
- be practical to package as Terraform for end users
- avoid requiring a Bedrock integration before users can deploy

## Platform Analysis

### AWS

AWS is the best primary deployment target for GuardianAgent in its current form.

Why:

- EC2 is a natural fit for a stateful Node.js process with local subprocesses, PTYs, SQLite, and optional colocated Ollama
- Systems Manager Session Manager gives a clean operator path without opening SSH to the internet
- AWS networking makes it straightforward to keep the app host and optional model host private
- GPU instance families exist for both minimum viable local-model hosting and stronger Ollama boxes

Important practical notes:

- EC2 G6 provides NVIDIA L4 GPUs with 24 GB of GPU memory
- EC2 G6e provides NVIDIA L40S GPUs with 48 GB of GPU memory
- ECS Fargate is not the right primary target for the full product because Fargate task definitions do not support `gpu`, and GuardianAgent's stateful local-host assumptions do not map cleanly to a stateless Fargate shape

AWS is also the safest initial platform if Terraform packaging is meant for other users. Its primitives for instance identity, disk encryption, VPC isolation, SSM access, and private networking are mature and easy to document.

### Cloudflare

Cloudflare is excellent for access control and ingress. It is not the best primary runtime for GuardianAgent as currently built.

Why Cloudflare is still valuable:

- Cloudflare Tunnel is a strong way to publish a private local origin without directly exposing the host
- Cloudflare Access is a strong identity gate in front of a private GuardianAgent web UI
- Cloudflare DNS, WAF-style policy, and Zero Trust access controls complement a private EC2 deployment very well

Why Cloudflare is not the best primary compute option:

- Workers do not provide the host semantics GuardianAgent depends on
- `child_process` is non-functional in Workers
- `node:sqlite` support is not yet there in Workers
- the Workers VFS is request-scoped rather than host-persistent
- Cloudflare Containers are still beta and currently small-instance oriented, with no GPU story for local Ollama and no reason to prefer them over EC2 for this workload

Conclusion:

- use Cloudflare in front of GuardianAgent
- do not use Cloudflare as the main GuardianAgent runtime target

### Managed AWS LLM Option vs Local Ollama

GuardianAgent can be deployed on AWS without using Bedrock.

This matters because Bedrock is not a built-in provider in the current runtime. A user who deploys GuardianAgent to AWS today can still:

- use local Ollama on the same EC2 host
- use a private Ollama host in the same VPC
- use one of the already supported external model providers

If Bedrock becomes a product goal later, it should be added as a first-party provider rather than treated as a deployment prerequisite.

## Recommended Deployment Model

### Primary Recommendation

Ship a Terraform-first deployment model with AWS as the compute substrate and Cloudflare as the optional private access layer.

The default install should not expose GuardianAgent directly to the public internet.

### Deployment Variants

#### Variant A: `headless_telegram`

Best for:

- users who mainly want Telegram interaction
- automation runs
- notifications and approvals
- low-complexity remote control without the browser dashboard

Shape:

- one EC2 instance
- no public inbound rules
- SSM-only administration
- GuardianAgent web either disabled or bound to `localhost` only
- Telegram enabled in polling mode
- outbound internet allowed for Telegram, browsing tools, optional external providers, and package retrieval where permitted
- Ollama local on the same host if GPU-backed, or omitted if external providers are used

Key point:

- no public-facing web UI is required for this mode

#### Variant B: `private_web_plus_telegram`

Best for:

- users who want the full dashboard
- users who want the Coding Assistant
- users who need approvals, config editing, and deeper operational visibility

Shape:

- one EC2 instance
- GuardianAgent web remains private
- remote browser access is provided only through Cloudflare Tunnel + Access or a VPN/private network path
- Telegram remains enabled for mobile interaction and notifications
- GuardianAgent's existing bearer auth remains enabled as a second layer until provider-backed web auth exists

Key point:

- the UI exists, but it is not public-facing in the ordinary sense

#### Variant C: `split_app_and_ollama`

Best for:

- larger Ollama models
- better isolation between app runtime and model runtime
- users who want to resize app and GPU capacity independently

Shape:

- one private CPU-oriented GuardianAgent host
- one private GPU-oriented Ollama host
- security-group rule allowing only GuardianAgent to reach Ollama on its API port
- no public exposure of Ollama
- private DNS name for the model endpoint inside the VPC

This is the right next step after the single-host deployment, not the first template to ship.

## Instance Recommendations

For the initial Terraform package, the practical guidance should be:

- minimum practical single-box local-Ollama deployment: `g6.2xlarge`
- recommended single-box local-Ollama deployment: `g6e.2xlarge`
- stronger single-box option for heavier use: `g6e.4xlarge`
- split deployment app host: a normal CPU instance such as an `m` or `c` family
- split deployment model host: `g6.2xlarge` minimum, `g6e.2xlarge` recommended

Reasoning:

- 24 GB VRAM is the minimum tier where local Ollama starts to feel practical for meaningful coding and agentic workloads
- 48 GB VRAM is a more comfortable tier for heavier agent workflows and larger context usage
- colocating GuardianAgent and Ollama also benefits from enough system RAM for Node, SQLite, browser tooling, buffers, and model-serving overhead

## Network And Exposure Model

GuardianAgent does not require public inbound internet just to function.

The right mental model is:

- inbound connectivity is optional
- outbound connectivity is required

Outbound access is needed for:

- Telegram polling
- web search and web-fetch tools
- browser tools
- optional external LLM APIs
- Cloudflare Tunnel if a private remote UI is enabled

Inbound access is needed only if:

- the operator wants remote web UI access
- the operator wants some custom integration path that is not Telegram, CLI, or SSM-driven

Recommended defaults:

- no inbound SSH
- no direct public exposure of GuardianAgent
- no direct public exposure of Ollama
- keep Ollama on loopback when colocated
- keep Ollama private when split
- use SSM for admin access
- use a private ingress pattern for the browser UI

## Terraform Packaging Plan

The Terraform delivery should be modular and opinionated.

Recommended modules:

- `modules/network`
- `modules/guardian_host`
- `modules/ollama_host`
- `modules/cloudflare_access`
- `modules/ops`

#### `modules/network`

Responsibilities:

- VPC
- private subnets
- route tables
- security groups
- optional NAT
- optional VPC endpoints for SSM-related AWS access

Default posture:

- private-by-default
- no inbound internet path to GuardianAgent or Ollama

#### `modules/guardian_host`

Responsibilities:

- EC2 instance
- IAM instance profile with least-privilege policies
- encrypted EBS volume
- systemd unit for GuardianAgent
- CloudWatch log wiring
- SSM management setup
- hardened OS bootstrap

Config defaults:

- `channels.web.host=localhost`
- bearer auth enabled
- Telegram off by default unless selected
- GuardianAgent service running as a dedicated non-root user

#### `modules/ollama_host`

Responsibilities:

- optional GPU EC2 instance
- encrypted model/data volume
- systemd unit for Ollama
- security group restricting access to the GuardianAgent host only

Config defaults:

- bind to loopback for same-host mode
- bind to private interface only for split-host mode

#### `modules/cloudflare_access`

Responsibilities:

- optional tunnel
- DNS record
- Access application
- Access policy

Important product note:

- this module should be optional
- Cloudflare should enhance the deployment, not define the primary compute model

#### `modules/ops`

Responsibilities:

- alarms
- instance health monitoring
- disk monitoring
- EBS snapshot policy
- optional backup hooks for GuardianAgent data directories

## Recommended Productized Presets

The top-level Terraform package should ship with a small number of concrete examples:

- `examples/headless_telegram`
- `examples/private_web_plus_telegram`
- `examples/single_node_local_ollama`
- `examples/split_app_and_ollama`

These examples should be the supported opinionated entry points, not a vague generic module set with no deployment guidance.

## Security Defaults

The shareable deployment should enforce safe defaults out of the box:

- no inbound SSH
- SSM for host access
- GuardianAgent web not publicly exposed
- Ollama not publicly exposed
- EBS encryption enabled
- IAM least privilege
- CloudWatch and SSM agent enabled
- outbound internet only where needed
- dedicated data directory for GuardianAgent state
- documented backup and restore process for SQLite-backed data

## Cost And Complexity Tradeoff

The preferred secure default is:

- private subnets
- SSM access
- optional Cloudflare private ingress

There is also a cheaper but weaker variant:

- public subnet
- no inbound rules
- Cloudflare Tunnel for the UI
- still no SSH

This weaker variant is acceptable for experiments, but it should not be the default template advertised as the secure deployment model.

## Follow-On Engineering Recommended

Several follow-on product changes would make the cloud deployment story stronger:

- first-party Bedrock provider support for AWS-native managed model access
- provider-backed web auth such as OIDC so private browser deployments do not rely on shared bearer tokens alone
- central session storage only if multi-instance web/API scaling becomes a goal
- explicit packaged service install scripts for Linux hosts
- deployment documentation for upgrade, backup, and rollback

These are useful uplifts, but they are not blockers for an initial AWS-first Terraform package.

## Decision

GuardianAgent should standardize on the following cloud recommendation:

- AWS is the primary deployment platform
- Cloudflare is the recommended optional private ingress and identity layer
- the default deployment is one stateful GuardianAgent runtime per tenant
- the default security posture is private-by-default with outbound internet access only
- the first packaged deployment artifact should be Terraform, not Kubernetes

In blunt terms:

- AWS for the runtime
- Cloudflare for the front door
- Ollama local or private
- no public GuardianAgent origin

## Sources

- AWS Session Manager pattern: <https://docs.aws.amazon.com/en_us/prescriptive-guidance/latest/patterns/connect-to-an-amazon-ec2-instance-by-using-session-manager.html>
- Amazon EC2 G6 instances: <https://aws.amazon.com/ec2/instance-types/g6/>
- Amazon EC2 G6e instances: <https://aws.amazon.com/ec2/instance-types/g6e/>
- Amazon ECS Fargate task-definition differences: <https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-tasks-services.html>
- Cloudflare Access for HTTP applications: <https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/>
- Cloudflare private application connectivity with Tunnel: <https://developers.cloudflare.com/learning-paths/clientless-access/connect-private-applications/>
- Cloudflare publishing applications with Terraform: <https://developers.cloudflare.com/learning-paths/clientless-access/terraform/publish-apps-with-terraform/>
- Cloudflare Workers Node.js compatibility: <https://developers.cloudflare.com/workers/runtime-apis/nodejs/>
- Cloudflare Containers limits: <https://developers.cloudflare.com/containers/platform-details/limits/>
