# Review new agent restrictions

The Copilot plugin includes a `guardrail-reviewer` custom agent and two command
hooks. `sessionStart` records the repository's starting commit; `postToolUse`
examines changed text and supplies review findings to Copilot as context. The base
commit survives commits made during that session, so committing an instruction
still leaves it in scope. The standalone `--check` command evaluates review
receipts for explicit local or CI validation.
Copilot discovers these components through `.plugin/plugin.json`; the root
`plugin.json` remains the skill-only adapter used by Grok.

The reviewer first removes obsolete instructions from their canonical source and
updates generated copies, fallback strings and references. Retaining a restriction
uses an exact-finding review in `.guardrail-reviews.json`:

```json
{
  "schema_version": 1,
  "reviews": [
    {
      "id": "FINDING_ID_FROM_THE_HOOK",
      "decision": "retain",
      "justification": "At least 7,500 trimmed Unicode characters explaining intrinsic benefit, necessity and the lack of adequate alternatives."
    }
  ]
}
```

The example justification is a placeholder and fails the length check. A finding
that describes data or code behavior can instead have `decision: "not_a_guardrail"`
with a specific `reason` and `evidence`. Physical removal resolves deleted rules;
a receipt describing deletion leaves any surviving instruction detectable.

Stage the receipt alongside the instruction change. Use the complete report
command provided by the hook for a chosen comparison. From the subject repository,
the standalone command is
`node /PATH/TO/PONYTAIL/hooks/guardrail-review.js --base COMMIT --check`.
The scanner finds lexical candidates in changed repository text. Changes to
instruction entrypoints such as AGENTS, CLAUDE, SKILL, HANDOFF and agent profiles
also request semantic review when their wording falls outside the patterns.
Unchanged notifications are deduplicated. The reviewer evaluates actual scope
and necessity; CLI checks validate the explicit candidates' recorded dispositions.

These files configure supported Copilot hook payloads; local tests simulate the
events. A live Copilot job is a separate runtime verification. GitHub documents
that hook timeouts can fall through.
See the [hook reference](https://docs.github.com/en/copilot/reference/hooks-reference)
and [legacy plugin component paths](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference).

Ponytail's normal behavior still comes from `skills/ponytail/SKILL.md`. A missing
or unreadable source now yields a short diagnostic, rather than a second embedded
copy of its rules. The independent `/ponytail-review` mode retains its own skill.
