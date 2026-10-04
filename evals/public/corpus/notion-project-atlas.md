---
source: notion
page_id: atlas-0001
---
# Project Atlas

Project Atlas replaces our reporting backend before the October launch.

## Owners

- Lena owns the data migration from the legacy reporting service.
- Priya owns customer onboarding and the pricing page.
- Omar owns authentication and session handling.

## Decisions

We chose PostgreSQL over MongoDB because our reporting needs relational joins across accounts, invoices and usage events.

We will keep the legacy reporting service read-only for 30 days after the migration, then shut it down.

## Rollout plan

The new reporting backend rolls out to 10 percent of accounts first, then 50 percent after one week without errors, then 100 percent.

## Open questions

- Do enterprise customers need a data export before the cutover?
