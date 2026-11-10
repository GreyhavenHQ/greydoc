// The sample document of the mockups, used to compare live mode with the view.
export const sample = `# Quarterly review

This document collects the **numbers** and the *open points* for the [Q4 review](https://example.com).

## Results

| Region | Revenue | Growth | Owner |
|--------|--------:|-------:|-------|
| Europe | 1.2 M€ | +8 % | Alice |
| North America | 2.4 M$ | +12 % | Bob |
| Asia | 0.9 M$ | +3 % | Chen |

> [!NOTE]
> Figures are unaudited until the end of the month.

### Next steps

- Confirm the budget with finance
- Hire two account managers
  - one in Lyon
  - one in Austin

1. Draft the plan
2. Review with the board

> Keep the summary under one page.

\`\`\`sql
select region, sum(amount) from sales group by region;
\`\`\`

Last edit: ==Friday== by the finance team.
`
