/** Thresholds shared by analyzers, report and CLI. Kept identical to the MetaLens SaaS so scores match. */
export const STALE_DAYS = 90;
export const VERY_STALE_DAYS = 180;
export const ACTIVE_DAYS = 30;
export const DASHBOARD_WARNING_STALE_RATIO = 0.7;
export const DASHBOARD_DETAILS_CAP = 300;
/** Metabase seeds this synthetic user as the author of the built-in "E-commerce Insights" demo assets. */
export const SAMPLE_USER_ID = 13371338;

/** Row counts above which a table is worth a partitioning or an indexing hint. */
export const PARTITION_ROW_HINT = 100000;
export const LARGE_TABLE_ROWS = 1000000;
/** How much a table has to be queried before clustering or materializing is worth suggesting. */
export const CLUSTER_USAGE_MIN = 10;
export const MATERIALIZE_USAGE_MIN = 50;
export const MATERIALIZE_COLUMN_MIN = 15;
