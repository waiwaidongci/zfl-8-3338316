import { loadCylinders } from "./cylinders.js";

const MS_PER_DAY = 86400000;

function daysUntil(dateText) {
  return Math.ceil((new Date(dateText).getTime() - Date.now()) / MS_PER_DAY);
}

function groupBy(cylinders, key) {
  return cylinders.reduce((acc, c) => {
    const val = c[key] || "unknown";
    acc[val] = (acc[val] || 0) + 1;
    return acc;
  }, {});
}

function computeInspectionDueSoon(cylinders, inspectionDays) {
  return cylinders
    .filter((c) => daysUntil(c.inspectionDue) <= inspectionDays)
    .map((c) => ({
      cylinderId: c.id,
      gasType: c.gasType,
      due: c.inspectionDue,
      daysLeft: daysUntil(c.inspectionDue)
    }));
}

function computeLongRent(cylinders, longRentDays) {
  return cylinders
    .filter((c) => {
      if (c.status !== "rented") return false;
      const lastOutbound = [...c.events].reverse().find((evt) => evt.type === "outbound");
      if (!lastOutbound) return false;
      return (Date.now() - new Date(lastOutbound.at).getTime()) / MS_PER_DAY >= longRentDays;
    })
    .map((c) => {
      const lastOutbound = [...c.events].reverse().find((evt) => evt.type === "outbound");
      return {
        cylinderId: c.id,
        gasType: c.gasType,
        customer: c.customer,
        since: lastOutbound.at,
        rentDays: Math.floor((Date.now() - new Date(lastOutbound.at).getTime()) / MS_PER_DAY)
      };
    });
}

function computeFillsStats(cylinders) {
  const allFills = cylinders.flatMap((c) => c.fills);
  return {
    totalFills: allFills.length,
    fillsByOperator: allFills.reduce((acc, f) => {
      if (f.operator) {
        acc[f.operator] = (acc[f.operator] || 0) + 1;
      }
      return acc;
    }, {})
  };
}

function computeEventsStats(cylinders) {
  const allEvents = cylinders.flatMap((c) => c.events);
  return allEvents.reduce((acc, e) => {
    acc[e.type] = (acc[e.type] || 0) + 1;
    return acc;
  }, {});
}

export function computeDashboard(cylinders, options = {}) {
  const inspectionDays = options.inspectionDays ?? 45;
  const longRentDays = options.longRentDays ?? 30;

  const inspectionDueSoon = computeInspectionDueSoon(cylinders, inspectionDays);
  const longRent = computeLongRent(cylinders, longRentDays);
  const fillsStats = computeFillsStats(cylinders);
  const eventsStats = computeEventsStats(cylinders);

  return {
    total: cylinders.length,
    byStatus: groupBy(cylinders, "status"),
    byGasType: groupBy(cylinders, "gasType"),
    inspectionDueSoon: {
      count: inspectionDueSoon.length,
      thresholdDays: inspectionDays,
      items: inspectionDueSoon
    },
    longRent: {
      count: longRent.length,
      thresholdDays: longRentDays,
      items: longRent
    },
    fills: fillsStats,
    events: eventsStats
  };
}

export async function getDashboard(options) {
  const cylinders = await loadCylinders();
  return computeDashboard(cylinders, options);
}
