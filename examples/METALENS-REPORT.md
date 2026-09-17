# Metabase health report: Northwind Outdoors
https://metabase.northwind-outdoors.example, Metabase v0.55.8, generated 2026-09-16
138 active questions, 11 dashboards, 1 database, 28 tables

## Health: C (36/100)

Foundation needs rework.

| Factor | Score | How to improve |
| --- | --- | --- |
| Content freshness | 14/35 | 58 of 138 questions are stale or unused (42%). Archive questions not accessed in 90+ days. Start with collections nobody owns. |
| No duplicates | 7/25 | 12 duplicate groups found. Consolidate duplicate queries, keep one canonical version per metric. |
| Documentation & organization | 4/20 | 4 organizational issues detected. Add descriptions to top-used questions. Move orphan queries into collections. |
| Dashboard reliability | 11/20 | 2 of 11 dashboards have broken cards, 4 are mostly stale. Fix or remove broken cards from active dashboards. That is what stakeholders see. |

## Do this first

1. **Fix 4 questions pointing at missing tables**: These questions read tables that no longer exist in the warehouse (legacy_subscriptions, fct_revenue, orders_2022, ...). They fail for everyone who opens them. (questions: [349](https://metabase.northwind-outdoors.example/question/349), [361](https://metabase.northwind-outdoors.example/question/361), [378](https://metabase.northwind-outdoors.example/question/378), [409](https://metabase.northwind-outdoors.example/question/409))
2. **Archive 11 exact duplicate queries**: 7 groups of structurally identical queries. Keep one from each group and archive the rest. (questions: [368](https://metabase.northwind-outdoors.example/question/368), [374](https://metabase.northwind-outdoors.example/question/374), [406](https://metabase.northwind-outdoors.example/question/406), [366](https://metabase.northwind-outdoors.example/question/366), [399](https://metabase.northwind-outdoors.example/question/399), and 6 more)
3. **Review 57 stale queries (90+ days unused)**: Nobody has opened these in 90+ days. Archive the ones that are no longer needed. (questions: [370](https://metabase.northwind-outdoors.example/question/370), [319](https://metabase.northwind-outdoors.example/question/319), [310](https://metabase.northwind-outdoors.example/question/310), [327](https://metabase.northwind-outdoors.example/question/327), [324](https://metabase.northwind-outdoors.example/question/324), and 45 more)
4. **Add descriptions to 83 questions**: 83 of 138 active questions have no description. Start with the most-viewed ones. (questions: [372](https://metabase.northwind-outdoors.example/question/372), [360](https://metabase.northwind-outdoors.example/question/360), [356](https://metabase.northwind-outdoors.example/question/356), [398](https://metabase.northwind-outdoors.example/question/398), [429](https://metabase.northwind-outdoors.example/question/429), and 15 more)
5. **Review 5 groups of questions with the same name**: Same name, different query. They may be old versions, or the same metric measured two ways. (questions: [415](https://metabase.northwind-outdoors.example/question/415), [311](https://metabase.northwind-outdoors.example/question/311), [323](https://metabase.northwind-outdoors.example/question/323), [438](https://metabase.northwind-outdoors.example/question/438), [312](https://metabase.northwind-outdoors.example/question/312), and 7 more)

## Duplicates (12 groups, 11 questions to archive)

**Keep [New subscribers by plan (weekly)](https://metabase.northwind-outdoors.example/question/328) (860 views, last used 2026-08-22)**
- Archive [new_subscribers_by_plan_v2](https://metabase.northwind-outdoors.example/question/368) (1 view, last used 2025-12-24)
- Archive [New subscribers by plan (copy)](https://metabase.northwind-outdoors.example/question/374) (16 views, last used 2026-04-15)
- Archive [Copy of New subscribers by plan](https://metabase.northwind-outdoors.example/question/406) (8 views, last used never)

These 4 queries are structurally identical. Keep New subscribers by plan (weekly), archive the other 3.

```bash
npx metabase-audit archive --ids 368,374,406
```

**Keep [Net revenue by day, last 90 days](https://metabase.northwind-outdoors.example/question/316) (2,380 views, last used 2026-08-30)**
- Archive [Net revenue by day (copy)](https://metabase.northwind-outdoors.example/question/366) (41 views, last used 2026-07-09)
- Archive [Daily revenue for standup](https://metabase.northwind-outdoors.example/question/399) (3 views, last used 2026-05-20)

These 3 queries are structurally identical. Keep Net revenue by day, last 90 days, archive the other 2.

```bash
npx metabase-audit archive --ids 366,399
```

**Keep [Top products by units sold, last 90 days](https://metabase.northwind-outdoors.example/question/338) (240 views, last used 2026-07-20)**
- Archive [Top SKUs for merchandising](https://metabase.northwind-outdoors.example/question/369) (10 views, last used 2025-07-24)
- Archive [Best sellers, last 30 days](https://metabase.northwind-outdoors.example/question/387) (29 views, last used 2026-06-10)

These 3 queries are structurally identical. Keep Top products by units sold, last 90 days, archive the other 2.

```bash
npx metabase-audit archive --ids 369,387
```

**Same name: Weekly Revenue (3 questions)**
- Most used: [Weekly Revenue](https://metabase.northwind-outdoors.example/question/415) (940 views, last used 2026-09-11)
- Review [Weekly Revenue](https://metabase.northwind-outdoors.example/question/311) (6 views, last used 2025-08-30)
- Review [Weekly Revenue](https://metabase.northwind-outdoors.example/question/323) (33 views, last used 2026-04-10)

3 questions share the name "Weekly Revenue". Review whether all of them are still needed, or consolidate into one.

**Same name: MRR (3 questions)**
- Most used: [MRR](https://metabase.northwind-outdoors.example/question/438) (1,640 views, last used 2026-08-25)
- Review [MRR](https://metabase.northwind-outdoors.example/question/312) (1 view, last used 2025-10-03)
- Review [MRR](https://metabase.northwind-outdoors.example/question/436) (96 views, last used 2026-07-18)

3 questions share the name "MRR". Review whether all of them are still needed, or consolidate into one.

**Keep [Refund rate by product category, trailing 30d](https://metabase.northwind-outdoors.example/question/335) (1,120 views, last used 2026-08-24)**
- Archive [Refund rate by category (2025 version)](https://metabase.northwind-outdoors.example/question/370) (12 views, last used 2024-11-29)

These 2 queries are structurally identical. Keep Refund rate by product category, trailing 30d, archive the other 1.

```bash
npx metabase-audit archive --ids 370
```

**Keep [Support tickets per 1k orders](https://metabase.northwind-outdoors.example/question/339) (410 views, last used 2026-08-30)**
- Archive [Contact rate per 1k orders (Ops)](https://metabase.northwind-outdoors.example/question/401) (55 views, last used 2026-08-04)

These 2 queries are structurally identical. Keep Support tickets per 1k orders, archive the other 1.

```bash
npx metabase-audit archive --ids 401
```

**Keep [Ad spend vs new customers by channel](https://metabase.northwind-outdoors.example/question/344) (190 views, last used 2026-05-08)**
- Archive [CAC by channel (working copy)](https://metabase.northwind-outdoors.example/question/365) (10 views, last used 2025-10-24)

These 2 queries are structurally identical. Keep Ad spend vs new customers by channel, archive the other 1.

```bash
npx metabase-audit archive --ids 365
```

**Keep [Session to order conversion by device](https://metabase.northwind-outdoors.example/question/351) (205 views, last used 2026-07-27)**
- Archive [Device conversion (rebuilt after tracking fix)](https://metabase.northwind-outdoors.example/question/413) (24 views, last used 2026-05-10)

These 2 queries are structurally identical. Keep Session to order conversion by device, archive the other 1.

```bash
npx metabase-audit archive --ids 413
```

**Same name: Orders by channel (2 questions)**
- Most used: [Orders by channel](https://metabase.northwind-outdoors.example/question/435) (122 views, last used 2026-09-07)
- Review [Orders by Channel](https://metabase.northwind-outdoors.example/question/322) (45 views, last used 2026-08-14)

2 questions share the name "Orders by channel" but read from different source tables (orders, fct_orders). They may be the same metric from different angles.

**Same name: Churn Rate (2 questions)**
- Most used: [Churn Rate](https://metabase.northwind-outdoors.example/question/334) (430 views, last used 2026-07-19)
- Review [Churn rate](https://metabase.northwind-outdoors.example/question/391) (32 views, last used 2026-05-30)

2 questions share the name "Churn Rate". Review whether all of them are still needed, or consolidate into one.

**Same name: Active Subscribers (2 questions)**
- Most used: [Active Subscribers](https://metabase.northwind-outdoors.example/question/388) (540 views, last used 2026-09-09)
- Review [Active Subscribers](https://metabase.northwind-outdoors.example/question/439) (25 views, last used 2026-07-01)

2 questions share the name "Active Subscribers". Review whether all of them are still needed, or consolidate into one.

## Broken questions (4)

| Question | Reason | Collection |
| --- | --- | --- |
| [Subscriptions imported from the old billing system](https://metabase.northwind-outdoors.example/question/349) | References missing table: legacy_subscriptions | Data Team / Scratch |
| [Daily net revenue (mart)](https://metabase.northwind-outdoors.example/question/361) | References missing table: fct_revenue | Board |
| [Revenue by month (2022 close)](https://metabase.northwind-outdoors.example/question/378) | References missing table: orders_2022 | Finance / Archive |
| [Support tickets by customer tier](https://metabase.northwind-outdoors.example/question/409) | References missing table: customer_ltv_mart | Support |

## Stale questions (57 not used in 90+ days)

| Question | Last used | Days | Views | Owner | Collection |
| --- | --- | --- | --- | --- | --- |
| [Refund rate by category (2025 version)](https://metabase.northwind-outdoors.example/question/370) | 2024-11-29 | 655 | 12 | Nadia Ferraro | Finance / Archive |
| [Cohort retention by signup month](https://metabase.northwind-outdoors.example/question/319) | 2025-02-08 | 585 | 8 | Priya Natarajan | Data Team / Scratch |
| [Email capture rate by device](https://metabase.northwind-outdoors.example/question/310) | 2025-03-05 | 560 | 9 | Ellis Barbour | Growth / Experiments |
| [CAC payback by cohort month](https://metabase.northwind-outdoors.example/question/327) | 2025-03-27 | 537 | 11 | Ellis Barbour | Growth |
| [Repeat purchase rate within 60 days](https://metabase.northwind-outdoors.example/question/324) | 2025-05-09 | 494 | 16 | Priya Natarajan | Growth |
| [Customers without an order](https://metabase.northwind-outdoors.example/question/380) | 2025-05-14 | 490 | 15 | Marcus Oyelaran | Growth |
| [Campaign list with budgets](https://metabase.northwind-outdoors.example/question/309) | 2025-05-25 | 478 | 3 | Ellis Barbour | Growth / Experiments |
| [MRR movement (new, expansion, churn)](https://metabase.northwind-outdoors.example/question/333) | 2025-07-04 | 438 | 7 | Marcus Oyelaran | Growth |
| [Churned MRR by plan, last 6 months](https://metabase.northwind-outdoors.example/question/394) | 2025-07-08 | 434 | 4 | Marcus Oyelaran | Growth |
| [Top SKUs for merchandising](https://metabase.northwind-outdoors.example/question/369) | 2025-07-24 | 419 | 10 | Nadia Ferraro | no collection |
| [Orders per customer distribution](https://metabase.northwind-outdoors.example/question/314) | 2025-08-29 | 382 | 4 | Priya Natarajan | Data Team / Scratch |
| [Weekly Revenue](https://metabase.northwind-outdoors.example/question/311) | 2025-08-30 | 381 | 6 | Ellis Barbour | Growth / Experiments |
| [Reactivations per month](https://metabase.northwind-outdoors.example/question/364) | 2025-09-23 | 357 | 7 | Marcus Oyelaran | Growth |
| [Ad spend efficiency by platform](https://metabase.northwind-outdoors.example/question/395) | 2025-09-28 | 353 | 13 | Ellis Barbour | Growth |
| [MRR](https://metabase.northwind-outdoors.example/question/312) | 2025-10-03 | 347 | 1 | Priya Natarajan | Data Team / Scratch |
| [Deferred revenue from annual plans](https://metabase.northwind-outdoors.example/question/332) | 2025-10-15 | 335 | 6 | Nadia Ferraro | Finance |
| [CAC by channel (working copy)](https://metabase.northwind-outdoors.example/question/365) | 2025-10-24 | 326 | 10 | Marcus Oyelaran | Growth / Experiments |
| [Revenue by month (2022 close)](https://metabase.northwind-outdoors.example/question/378) | 2025-10-27 | 323 | 11 | Rosa Villalobos | Finance / Archive |
| [Subscriptions imported from the old billing system](https://metabase.northwind-outdoors.example/question/349) | 2025-12-15 | 274 | 16 | Priya Natarajan | Data Team / Scratch |
| [NPS detractor comments, last 30 days](https://metabase.northwind-outdoors.example/question/362) | 2025-12-20 | 269 | 11 | Nadia Ferraro | Board |
| [new_subscribers_by_plan_v2](https://metabase.northwind-outdoors.example/question/368) | 2025-12-24 | 265 | 1 | Priya Natarajan | Data Team / Scratch |
| [Sessions from paid campaigns](https://metabase.northwind-outdoors.example/question/302) | 2025-12-26 | 263 | 10 | Ellis Barbour | Growth / Experiments |
| [Sessions by landing path](https://metabase.northwind-outdoors.example/question/303) | 2026-01-09 | 249 | 7 | Ellis Barbour | Growth / Experiments |
| [Order items for the packaging test](https://metabase.northwind-outdoors.example/question/405) | 2026-02-07 | 220 | 8 | Priya Natarajan | Personal / Priya Natarajan |
| [Search to purchase rate](https://metabase.northwind-outdoors.example/question/308) | 2026-03-02 | 197 | 16 | Priya Natarajan | Growth / Experiments |
| [Lifetime value buckets](https://metabase.northwind-outdoors.example/question/382) | 2026-03-03 | 196 | 11 | Marcus Oyelaran | Growth |
| [Campaign performance, last 28 days](https://metabase.northwind-outdoors.example/question/317) | 2026-03-07 | 192 | 12 | Ellis Barbour | Growth |
| [Plan mix over time](https://metabase.northwind-outdoors.example/question/355) | 2026-03-28 | 171 | 34 | Marcus Oyelaran | Growth |
| [Customers acquired by source](https://metabase.northwind-outdoors.example/question/371) | 2026-04-04 | 164 | 19 | Marcus Oyelaran | Growth |
| [Event volume by name, last 7 days](https://metabase.northwind-outdoors.example/question/404) | 2026-04-04 | 164 | 22 | Priya Natarajan | Data Team / Scratch |
| [Weekly Revenue](https://metabase.northwind-outdoors.example/question/323) | 2026-04-10 | 158 | 33 | Henrik Solberg | Ops |
| [New subscribers by plan (copy)](https://metabase.northwind-outdoors.example/question/374) | 2026-04-15 | 153 | 16 | Ellis Barbour | Growth / Experiments |
| [Subscription plan mix](https://metabase.northwind-outdoors.example/question/381) | 2026-04-16 | 152 | 22 | Marcus Oyelaran | Growth |
| [First order value by acquisition source](https://metabase.northwind-outdoors.example/question/396) | 2026-04-16 | 152 | 3 | Ellis Barbour | Growth / Experiments |
| [Tax collected by state, quarterly](https://metabase.northwind-outdoors.example/question/350) | 2026-04-18 | 150 | 5 | Rosa Villalobos | Finance |
| [Subscription events, one customer](https://metabase.northwind-outdoors.example/question/313) | 2026-04-19 | 149 | 26 | Priya Natarajan | Personal / Priya Natarajan |
| [Daily net revenue (mart)](https://metabase.northwind-outdoors.example/question/361) | 2026-04-20 | 149 | 10 | Grant Ishikawa | Board |
| [Reopened tickets share](https://metabase.northwind-outdoors.example/question/315) | 2026-05-06 | 132 | 3 | Jamie Okonkwo | Support |
| [Ad spend vs new customers by channel](https://metabase.northwind-outdoors.example/question/344) | 2026-05-08 | 130 | 190 | Ellis Barbour | Growth |
| [Device conversion (rebuilt after tracking fix)](https://metabase.northwind-outdoors.example/question/413) | 2026-05-10 | 128 | 24 | Priya Natarajan | Data Team / Scratch |
| [Trial share of new revenue](https://metabase.northwind-outdoors.example/question/326) | 2026-05-13 | 126 | 34 | Rosa Villalobos | Finance |
| [Support tickets by customer tier](https://metabase.northwind-outdoors.example/question/409) | 2026-05-13 | 126 | 18 | Jamie Okonkwo | Support |
| [Customers by country and state](https://metabase.northwind-outdoors.example/question/393) | 2026-05-13 | 125 | 24 | Grant Ishikawa | Board |
| [Products without an inventory record](https://metabase.northwind-outdoors.example/question/353) | 2026-05-17 | 121 | 5 | Henrik Solberg | Ops |
| [Revenue recognized vs cash collected](https://metabase.northwind-outdoors.example/question/320) | 2026-05-20 | 118 | 8 | Grant Ishikawa | Finance |
| [Daily revenue for standup](https://metabase.northwind-outdoors.example/question/399) | 2026-05-20 | 118 | 3 | Henrik Solberg | Ops |
| [Paid vs organic revenue split](https://metabase.northwind-outdoors.example/question/340) | 2026-05-21 | 117 | 12 | Marcus Oyelaran | Growth |
| [Trial starts by week](https://metabase.northwind-outdoors.example/question/402) | 2026-05-21 | 117 | 6 | Ellis Barbour | Growth |
| [Orders per day with empty days filled in](https://metabase.northwind-outdoors.example/question/342) | 2026-05-28 | 110 | 10 | Henrik Solberg | no collection |
| [Churn rate](https://metabase.northwind-outdoors.example/question/391) | 2026-05-30 | 108 | 32 | Marcus Oyelaran | Growth |

and 7 more, see .metalens/findings.json

## Dashboards (11)

| Dashboard | Status | Questions | Stale | Broken | Views | Last viewed | Owner |
| --- | --- | --- | --- | --- | --- | --- | --- |
| [Board KPIs](https://metabase.northwind-outdoors.example/dashboard/4401) | healthy | 8 | 0 | 0 | 2,100 | 2026-09-15 | Dana Whitfield |
| [Weekly Revenue](https://metabase.northwind-outdoors.example/dashboard/4402) | healthy | 6 | 2 | 0 | 640 | 2026-09-13 | Rosa Villalobos |
| [Ops Daily](https://metabase.northwind-outdoors.example/dashboard/4405) | healthy | 6 | 1 | 0 | 480 | 2026-09-15 | Henrik Solberg |
| [Subscription Health](https://metabase.northwind-outdoors.example/dashboard/4403) | warning | 6 | 5 | 0 | 310 | 2026-06-12 | Marcus Oyelaran |
| [Marketing Attribution](https://metabase.northwind-outdoors.example/dashboard/4404) | warning | 5 | 4 | 0 | 220 | 2026-04-27 | Ellis Barbour |
| [Support Overview](https://metabase.northwind-outdoors.example/dashboard/4406) | broken | 5 | 2 | 1 | 190 | 2026-09-14 | Jamie Okonkwo |
| [Inventory](https://metabase.northwind-outdoors.example/dashboard/4410) | healthy | 4 | 0 | 0 | 150 | 2026-09-12 | Henrik Solberg |
| [Executive Summary (legacy)](https://metabase.northwind-outdoors.example/dashboard/4411) | broken | 6 | 4 | 1 | 130 | 2026-07-01 | Grant Ishikawa |
| [Cohorts 2023](https://metabase.northwind-outdoors.example/dashboard/4407) | warning | 4 | 4 | 0 | 95 | 2025-12-02 | Priya Natarajan |
| [Q3 Planning (old)](https://metabase.northwind-outdoors.example/dashboard/4408) | warning | 3 | 3 | 0 | 60 | 2025-10-20 | Nadia Ferraro |
| [Priya scratch](https://metabase.northwind-outdoors.example/dashboard/4409) | unknown | 0 | 0 | 0 | 12 | 2026-08-13 | Priya Natarajan |

## Ownership

| Owner | Questions | Active | Stale |
| --- | --- | --- | --- |
| Marcus Oyelaran | 26 | 13 | 13 |
| Henrik Solberg | 24 | 19 | 5 |
| Rosa Villalobos | 20 | 15 | 5 |
| Priya Natarajan | 16 | 5 | 11 |
| Ellis Barbour | 13 | 0 | 13 |
| Jamie Okonkwo | 12 | 9 | 3 |
| Nadia Ferraro | 10 | 6 | 4 |
| Dana Whitfield | 9 | 9 | 0 |
| API key user 41 | 4 | 4 | 0 |
| Grant Ishikawa | 3 | 0 | 3 |
| API key user 57 | 1 | 1 | 0 |

## Core data model

Ordered by how many saved questions read each table.

| Table | Questions | Rows | Columns | Referenced by |
| --- | --- | --- | --- | --- |
| public.orders | 35 | 1,284,000 | 18 | fct_orders, order_items, payments, refunds, shipments, support_tickets |
| public.subscriptions | 18 | 96,500 | 11 | fct_subscription_mrr, int_subscription_periods, subscription_events |
| public.customers | 13 | 412,000 | 12 | dim_customers, events, fct_orders, fct_subscription_mrr, nps_responses, orders, orders_backup_2023, payments, sessions, subscription_events, subscriptions, support_tickets, tmp_cohort_export |
| public.support_tickets | 12 | 158,000 | 12 | none |
| dbt_marts.fct_orders | 10 | 1,284,000 | 11 | none |
| public.order_items | 9 | 3,942,000 | 8 | none |
| public.products | 9 | 4,300 | 11 | dim_products, inventory, order_items |
| public.sessions | 9 | 12,400,000 | 11 | events |
| public.inventory | 8 | 68,400 | 7 | none |
| dbt_marts.dim_customers | 7 | 412,000 | 9 | none |
| dbt_marts.fct_revenue_daily | 7 | 14,600 | 7 | none |
| public.subscription_events | 7 | 1,118,000 | 8 | none |
| public.ad_spend | 6 | 214,000 | 9 | none |
| public.shipments | 6 | 1,190,000 | 10 | none |
| dbt_marts.fct_subscription_mrr | 5 | 1,158,000 | 7 | none |

and 13 more, see .metalens/findings.json

- **public.orders**: Partition by placed_at (range partitioning on placed_at)
- **public.orders**: Add composite index on (customer_id, status, channel)
- **public.orders**: Large table (1.3M rows), ensure proper indexing
- **public.subscriptions**: Add composite index on (customer_id, plan_code, status)
- **public.customers**: Partition by created_at (range partitioning on created_at)
- **public.customers**: Add composite index on (signup_source, marketing_opt_in)
- **public.support_tickets**: Partition by opened_at (range partitioning on opened_at)
- **public.support_tickets**: Add composite index on (customer_id, order_id, category)
- **dbt_marts.fct_orders**: Partition by order_date (range partitioning on order_date)
- **dbt_marts.fct_orders**: Add composite index on (order_id, customer_id, channel)

## Anomalies

- medium: 6 tables have zero query references (customers_old, dim_dates, events_legacy, orders_backup_2023, tmp_cohort_export)
- low: 27 queries haven't been accessed in 180+ days (Sessions from paid campaigns, Sessions by landing path, Search to purchase rate, Campaign list with budgets, Email capture rate by device)
- medium: 83 of 138 active questions have no description (60% undocumented)
- low: 12 questions are not organized in any collection (Orders per day with empty days filled in, Weekly digest numbers, Trials expiring in the next seven days, Top SKUs for merchandising, Sessions by device type)

## How to act on this

Preview a cleanup. This changes nothing:

```bash
npx metabase-audit archive --from duplicates
```

Add `--apply` to carry it out. Every apply writes an undo file into `.metalens/` before it touches a question, and `unarchive` puts the questions back:

```bash
npx metabase-audit archive --from duplicates --apply
npx metabase-audit unarchive --undo .metalens/undo-<timestamp>.json --apply
```

`DATA-CONTEXT.md`, written next to this report, describes the same instance for an LLM: schema, relationships, the queries the team trusts and a glossary. Paste it into Claude when you want help writing a question or planning a migration.

If the findings are clear but the decisions are not (who owns what, which definition is right), see the README section When the report is not enough.
