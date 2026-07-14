# External design protocol provenance

The Creative Director Pipeline contains adapted protocols from the four pinned
sources below. They are not runtime dependencies or runtime integrations. No
upstream repository is fetched, imported, invoked, or required by deterministic
scripts. These sources do not independently prove that this repository's
output is better; local tests, visual evidence, and the blind benchmark are the
only acceptance authorities.

| Source and pinned revision | Adapted protocol | Local implementation boundary |
|---|---|---|
| [`leonxlnx/taste-skill@b17742737e796305d829b3ad39eda3add0d79060`](https://github.com/leonxlnx/taste-skill/tree/b17742737e796305d829b3ad39eda3add0d79060) | Context-first taste, explicit profile, anti-slop review | `deck.plan.json` context/design intent, contextual taste dials, calibrated anti-slop rules |
| [`pbakaus/impeccable@f2049c2b76383b444bf30cd6184f7d49a6c580d1`](https://github.com/pbakaus/impeccable/tree/f2049c2b76383b444bf30cd6184f7d49a6c580d1) | Named critique and refinement vocabulary | Closed refinement commands, evidence-routed dry run, one Host-approved reversible delta |
| [`jinbaozi/Visual-Proof-Gate@9742d87b8d6441d1b344ebc9de16548656e60b3e`](https://github.com/jinbaozi/Visual-Proof-Gate/tree/9742d87b8d6441d1b344ebc9de16548656e60b3e) | Screenshot-bound visual proof before acceptance | Creative Proof 0.2, full-size slide evidence, packet-bound mandatory Host review |
| [`Trystan-SA/claude-design-system-prompt@3c3ddb07d7aa3fef051d83608596470c95cfd8fe`](https://github.com/Trystan-SA/claude-design-system-prompt/tree/3c3ddb07d7aa3fef051d83608596470c95cfd8fe) | Explicit design intent and system-level visual reasoning | Structured `context` and `designIntent`, selected DESIGN.md, Semantic Slide IR; no embedded long prompt |

The adaptation is intentionally architectural: small focused contracts,
deterministic schemas, auditable evidence, and Host-owned judgment replace raw
prompt concatenation. Upstream names are provenance only and must not appear in
claims that imply installed capabilities, live API calls, or measured effects.
