#!/usr/bin/env node
import {
  backupHistoryMonth,
  backupHistoryRange,
  estimateHistoryMonths,
  listHistoryMonths,
  maintainWeeklyHistoryUser,
  parseHistoryMonth,
  previousClosedHistoryMonth,
  resolveHistoryUsers,
  type HistoryMonth,
} from "../lib/history-backup.ts";
import { historyStore } from "../lib/history-store.ts";

type Args = Record<string, string | boolean>;

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [key, ...valueParts] = arg.slice(2).split("=");
    args[key] = valueParts.length > 0 ? valueParts.join("=") : true;
  }
  return args;
}

function readString(args: Args, key: string, fallback = "") {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function monthLabel(month: Pick<HistoryMonth, "year" | "month">) {
  return `${month.year}-${String(month.month).padStart(2, "0")}`;
}

function defaultFromMonth() {
  return parseHistoryMonth("2016-01");
}

function resolveRange(args: Args) {
  const from = readString(args, "from");
  const to = readString(args, "to");
  return {
    from: from ? parseHistoryMonth(from) : defaultFromMonth(),
    to: to ? parseHistoryMonth(to) : previousClosedHistoryMonth(),
  };
}

function printRows(rows: Array<Record<string, unknown>>) {
  for (const row of rows) console.log(JSON.stringify(row));
}

async function estimate(args: Args) {
  const users = resolveHistoryUsers(readString(args, "user", "leo"));
  const range = resolveRange(args);
  const summaries = [];
  for (const user of users) {
    const rows = await estimateHistoryMonths(user, listHistoryMonths(range.from, range.to));
    const total = rows.reduce((sum, row) => sum + row.expectedCount, 0);
    const pages = rows.reduce((sum, row) => sum + row.pages, 0);
    printRows(rows.map((row) => ({
      user: row.userKey,
      month: monthLabel(row),
      expectedCount: row.expectedCount,
      pages: row.pages,
      ok: row.ok,
      status: row.status,
    })));
    summaries.push({
      user: user.key,
      from: monthLabel(range.from),
      to: monthLabel(range.to),
      months: rows.length,
      expectedCount: total,
      pages,
    });
  }
  console.log(JSON.stringify({ summary: summaries.length === 1 ? summaries[0] : summaries }));
}

async function backfill(args: Args) {
  const users = resolveHistoryUsers(readString(args, "user", "leo"));
  const range = resolveRange(args);
  await historyStore.ensureReady();
  for (const user of users) {
    const results = await backupHistoryRange(user, listHistoryMonths(range.from, range.to));
    printRows(results.map((result) => ({
      user: result.userKey,
      month: monthLabel(result),
      expectedCount: result.expectedCount,
      fetchedCount: result.fetchedCount,
      storedCount: result.storedCount,
      skippedCount: result.skippedCount,
      status: result.status,
      errors: result.errors,
    })));
  }
}

async function backupPreviousMonth(args: Args) {
  const users = resolveHistoryUsers(readString(args, "user", "leo"));
  const month = previousClosedHistoryMonth();
  await historyStore.ensureReady();
  for (const user of users) {
    const result = await backupHistoryMonth(user, month);
    printRows([{
      user: result.userKey,
      month: monthLabel(result),
      expectedCount: result.expectedCount,
      fetchedCount: result.fetchedCount,
      storedCount: result.storedCount,
      skippedCount: result.skippedCount,
      status: result.status,
      errors: result.errors,
    }]);
  }
}

async function maintainWeekly(args: Args) {
  const users = resolveHistoryUsers(readString(args, "user", "all"));
  await historyStore.ensureReady();
  const failures: Array<{ user: string; message: string }> = [];

  for (const user of users) {
    try {
      const result = await maintainWeeklyHistoryUser(user);
      printRows([{
        user: result.userKey,
        pendingFrom: new Date(result.pendingFromMs).toISOString(),
        nextPendingFrom: new Date(result.nextPendingFromMs).toISOString(),
        latestEventAt: result.latestEventAtMs == null
          ? null
          : new Date(result.latestEventAtMs).toISOString(),
        latestAdvanced: result.latestAdvanced,
        fullBackfill: result.fullBackfill,
        hasImported: result.hasImported,
        syncEnabled: result.syncEnabled,
        checkedMonths: result.checkedMonths,
        reconciledMonths: result.reconciledMonths,
        changedMonths: result.changedMonths,
        statuses: Object.fromEntries(
          result.results.map((entry) => [monthLabel(entry), entry.status])
        ),
      }]);
    } catch (error: any) {
      const message = error?.message ?? String(error);
      failures.push({ user: user.key, message });
      console.error(JSON.stringify({ user: user.key, error: message }));
    }
  }

  if (failures.length > 0) {
    throw new Error(`Weekly history maintenance failed for ${failures.map((entry) => entry.user).join(", ")}`);
  }
}

async function reconcile(args: Args) {
  const users = resolveHistoryUsers(readString(args, "user", "leo"));
  const monthArg = readString(args, "month");
  if (!monthArg) throw new Error("--month=YYYY-MM is required for reconcile");
  await historyStore.ensureReady();
  for (const user of users) {
    const result = await backupHistoryMonth(user, parseHistoryMonth(monthArg));
    printRows([{
      user: result.userKey,
      month: monthLabel(result),
      expectedCount: result.expectedCount,
      fetchedCount: result.fetchedCount,
      storedCount: result.storedCount,
      skippedCount: result.skippedCount,
      status: result.status,
      errors: result.errors,
    }]);
  }
}

async function status(args: Args) {
  await historyStore.ensureReady();
  const user = readString(args, "user");
  const userKeys = user && user !== "all"
    ? resolveHistoryUsers(user).map((entry) => entry.key)
    : [];
  const rows = userKeys.length > 0
    ? (await Promise.all(userKeys.map((userKey) => historyStore.listMonths(userKey)))).flat()
    : await historyStore.listMonths();
  printRows(rows.map((row) => ({
    user: row.userKey,
    month: monthLabel(row),
    expectedCount: row.expectedCount,
    storedCount: row.storedCount,
    status: row.status,
    error: row.error,
    completedAt: row.completedAt,
  })));
}

const command = process.argv[2] || "help";
const args = parseArgs(process.argv.slice(3));
const commands: Record<string, (args: Args) => Promise<void>> = {
  estimate,
  backfill,
  "maintain-weekly": maintainWeekly,
  "backup-previous-month": backupPreviousMonth,
  reconcile,
  status,
};

if (!commands[command]) {
  console.log("Usage:");
  console.log("  tsx scripts/history.ts estimate --user=leo --from=2016-01 --to=2026-05");
  console.log("  tsx scripts/history.ts estimate --user=all --from=2026-05 --to=2026-05");
  console.log("  tsx scripts/history.ts backfill --user=leo,gab --from=2024-01 --to=2024-12");
  console.log("  tsx scripts/history.ts maintain-weekly --user=all");
  console.log("  tsx scripts/history.ts backup-previous-month --user=all");
  console.log("  tsx scripts/history.ts reconcile --user=leo --month=2024-09");
  console.log("  tsx scripts/history.ts status --user=leo");
  process.exit(command === "help" ? 0 : 1);
}

commands[command](args).catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
